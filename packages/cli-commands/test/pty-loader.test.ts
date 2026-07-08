// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the graceful node-pty loader (M G4 Step 2, D104.D / D104.M.2).
//
// The loader is the single native-dependency seam: it dynamic-imports the
// OPTIONAL `node-pty` and MUST degrade to `null` -- never throw -- when the
// module is absent, fails to load, or lacks a callable `spawn`. These tests
// inject a fake importer so the absent / present / broken paths run
// deterministically, independent of whether node-pty is installed on the host.
// A final case drives the real default importer and asserts only the contract
// (module-or-null, never rejects) so it is platform-agnostic.

import { describe, expect, it } from "vitest";

import { loadPtyModule } from "../src/commands/pty-loader.js";

/** A stand-in for node-pty's `spawn` -- only its being a function matters. */
function fakeSpawn(): unknown {
  return {};
}

/** An importer that resolves to `value` (a fake node-pty module namespace). */
function resolvesTo(value: unknown): () => Promise<unknown> {
  return () => Promise.resolve(value);
}

describe("loadPtyModule -- absent / failed import (degrades to null, never throws)", () => {
  it("returns null when the importer rejects (module not found)", async () => {
    const importer = () => Promise.reject(new Error("Cannot find module 'node-pty'"));
    await expect(loadPtyModule(importer)).resolves.toBeNull();
  });

  it("returns null when the importer throws synchronously", async () => {
    const importer = () => {
      throw new Error("native binding failed to load");
    };
    await expect(loadPtyModule(importer)).resolves.toBeNull();
  });

  it("returns null when the module resolves to null", async () => {
    await expect(loadPtyModule(resolvesTo(null))).resolves.toBeNull();
  });

  it("returns null when the module resolves to undefined", async () => {
    await expect(loadPtyModule(resolvesTo(undefined))).resolves.toBeNull();
  });

  it("returns null for a non-object module (primitive)", async () => {
    await expect(loadPtyModule(resolvesTo("node-pty"))).resolves.toBeNull();
  });
});

describe("loadPtyModule -- present module shapes", () => {
  it("accepts `spawn` on the namespace directly", async () => {
    const mod = { spawn: fakeSpawn };
    const result = await loadPtyModule(resolvesTo(mod));
    expect(result).toBe(mod);
    expect(result?.spawn).toBeTypeOf("function");
  });

  it("accepts `spawn` under `default` (ESM<->CJS interop) and returns the default", async () => {
    const dflt = { spawn: fakeSpawn };
    const mod = { __esModule: true, default: dflt };
    const result = await loadPtyModule(resolvesTo(mod));
    expect(result).toBe(dflt);
  });

  it("prefers `default` when both namespace and default expose spawn (node-pty's real shape)", async () => {
    const dflt = { spawn: fakeSpawn };
    const mod = { __esModule: true, default: dflt, spawn: fakeSpawn };
    const result = await loadPtyModule(resolvesTo(mod));
    expect(result).toBe(dflt);
  });

  it("falls back to the namespace when `default` exists but lacks a callable spawn", async () => {
    const mod = { default: { notSpawn: 1 }, spawn: fakeSpawn };
    const result = await loadPtyModule(resolvesTo(mod));
    expect(result).toBe(mod);
    expect(result?.spawn).toBeTypeOf("function");
  });
});

describe("loadPtyModule -- present but broken (no callable spawn -> null)", () => {
  it("returns null when no spawn exists on namespace or default", async () => {
    await expect(loadPtyModule(resolvesTo({ fork: fakeSpawn }))).resolves.toBeNull();
  });

  it("returns null when spawn is present but not a function", async () => {
    await expect(loadPtyModule(resolvesTo({ spawn: 42 }))).resolves.toBeNull();
  });

  it("returns null when neither default nor namespace has a callable spawn", async () => {
    const mod = { default: { spawn: "nope" }, spawn: 0 };
    await expect(loadPtyModule(resolvesTo(mod))).resolves.toBeNull();
  });
});

describe("loadPtyModule -- default importer (real node-pty; module-or-null, never throws)", () => {
  it("resolves to a module with a callable spawn OR null, and never rejects", async () => {
    const result = await loadPtyModule();
    const contractHeld = result === null || typeof result.spawn === "function";
    expect(contractHeld).toBe(true);
  });
});
