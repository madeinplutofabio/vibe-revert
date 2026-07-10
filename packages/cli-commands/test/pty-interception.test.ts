// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4a: the interception CONTRACT is types + constants + the one branded
// handle factory. Only the runtime values are testable; the closed-set/subset
// relationships are compile-time (checked by tsc). The brand is a real private
// symbol, so the handle carries exactly one (opaque) symbol property.

import { describe, expect, it } from "vitest";

import {
  createInstalledInterceptionHandle,
  type InterceptionChannelRef,
  PTY_INTERCEPTION_DECISION_TIMEOUT_MS,
  PTY_INTERCEPTION_PROTOCOL_VERSION,
} from "../src/commands/pty-interception.js";

describe("pty-interception contract (M G4 Step 4a)", () => {
  it("pins the protocol version at 1", () => {
    expect(PTY_INTERCEPTION_PROTOCOL_VERSION).toBe(1);
  });

  it("uses a positive fail-closed decision timeout", () => {
    expect(PTY_INTERCEPTION_DECISION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("createInstalledInterceptionHandle stamps a well-formed, branded handle", () => {
    const channel: InterceptionChannelRef = { endpoint: "loopback:0" };
    const handle = createInstalledInterceptionHandle({
      shellKind: "bash",
      nonce: "nonce-abc",
      channel,
    });

    expect(handle.shellKind).toBe("bash");
    expect(handle.nonce).toBe("nonce-abc");
    expect(handle.channel).toEqual({ endpoint: "loopback:0" });

    // The brand is a real, private symbol property (honest runtime artifact);
    // the test never imports the symbol, only asserts its shape. `as unknown as`
    // is required: InstalledInterception has no symbol index signature (TS2352).
    const symbols = Object.getOwnPropertySymbols(handle);
    expect(symbols).toHaveLength(1);
    expect((handle as unknown as Record<symbol, unknown>)[symbols[0] as symbol]).toBe(true);
  });
});
