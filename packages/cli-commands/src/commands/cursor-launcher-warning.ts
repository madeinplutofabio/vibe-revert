// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Warn-only advisory surfaced by `viberevert install --cursor` after a
// successful Cursor MCP install/update ON WINDOWS. The generated
// `.cursor/mcp.json` VibeRevert entry uses the Windows-specific `cmd /c` form
// (Cursor cannot spawn the bare `viberevert` shim on Windows), which is
// host-specific. This note tells the user so — without touching `.gitignore` or
// claiming the whole file is machine-specific.
//
// Fixed text only: no filesystem reads, no platform/config inspection. A
// synchronous stderr write failure is swallowed so the warning path never
// blocks install — matching `printGitignoreWarning`'s contract. Asynchronous
// stream 'error' events (e.g. from a destroyed stream) are out of scope; the
// caller owns stream robustness.

import type { RecordKey } from "@viberevert/adapters";

/**
 * Write the Windows Cursor launcher portability advisory to `stderr`.
 *
 * Two `warning:` lines plus a trailing blank (mirrors `printGitignoreWarning`).
 * Never throws synchronously. Call ONLY after a successful Cursor install/update
 * on a Windows host — never for uninstall, refusal, unrelated adapters, or
 * non-Windows hosts.
 */
export function printCursorWindowsLauncherWarning(stderr: NodeJS.WritableStream): void {
  const message =
    "warning: The VibeRevert Cursor MCP launcher was generated for Windows using `cmd /c`.\n" +
    "warning: If this repository is shared across operating systems, regenerate the " +
    "VibeRevert Cursor integration on each host or manage the platform-specific " +
    "VibeRevert entry separately.\n\n";

  try {
    stderr.write(message);
  } catch {
    // Warning-only: a synchronously throwing stderr must not block install.
  }
}

/** Whether a successful adapter apply requires the Windows Cursor advisory. */
export function cursorWindowsLauncherWarningApplies(
  recordKey: RecordKey,
  platform: NodeJS.Platform,
): boolean {
  return recordKey === "cursor" && platform === "win32";
}
