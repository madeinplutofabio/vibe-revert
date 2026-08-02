// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  cursorWindowsLauncherWarningApplies,
  printCursorWindowsLauncherWarning,
} from "../src/commands/cursor-launcher-warning.js";

// The exact bytes the emitter must write: two `warning:` lines + a trailing
// blank line. Pinned independently of the production string so a change to
// either side is caught.
const EXPECTED =
  "warning: The VibeRevert Cursor MCP launcher was generated for Windows using `cmd /c`.\n" +
  "warning: If this repository is shared across operating systems, regenerate the " +
  "VibeRevert Cursor integration on each host or manage the platform-specific " +
  "VibeRevert entry separately.\n\n";

/** A Writable that accumulates everything written as UTF-8 text. */
function capturingStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

describe("printCursorWindowsLauncherWarning", () => {
  it("writes the exact two-line advisory plus a trailing blank line, without throwing", () => {
    const { stream, text } = capturingStream();
    expect(() => printCursorWindowsLauncherWarning(stream)).not.toThrow();
    expect(text()).toBe(EXPECTED);
  });

  it("swallows a synchronously throwing write (the documented non-blocking contract)", () => {
    // A stream-like sink whose write throws synchronously. This exercises ONLY
    // the guaranteed sync-swallow path — not async 'error'-event recovery, which
    // the helper explicitly does not promise.
    const syncThrowingSink = {
      write(): never {
        throw new Error("boom");
      },
    } as unknown as NodeJS.WritableStream;
    expect(() => printCursorWindowsLauncherWarning(syncThrowingSink)).not.toThrow();
  });
});

describe("cursorWindowsLauncherWarningApplies", () => {
  it("cursor + win32 -> true (the only case that warns)", () => {
    expect(cursorWindowsLauncherWarningApplies("cursor", "win32")).toBe(true);
  });

  it("cursor + non-Windows -> false", () => {
    expect(cursorWindowsLauncherWarningApplies("cursor", "linux")).toBe(false);
    expect(cursorWindowsLauncherWarningApplies("cursor", "darwin")).toBe(false);
  });

  it("non-cursor adapters + win32 -> false", () => {
    expect(cursorWindowsLauncherWarningApplies("claude", "win32")).toBe(false);
    expect(cursorWindowsLauncherWarningApplies("github-action", "win32")).toBe(false);
  });
});
