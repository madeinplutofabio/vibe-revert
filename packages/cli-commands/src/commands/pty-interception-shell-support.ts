// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

/**
 * Interception hook capability matrix (M G4 Step 4c, D104.E/O). The FIRST gate
 * in the interception-install path: it classifies a resolved interactive shell
 * as interception-capable or not. PTY interception (the Step 4d hook + the 4b
 * channel) currently supports ONLY bash; every other shell family -- and any
 * future ShellKind -- is refused, so a new family can never silently become an
 * unguarded PTY. A refusal produces no InstalledInterception (4a) -> no spawn
 * (4e). Pure: no hook strings, no channel, no I/O.
 */

import type { InterceptionShellSupport } from "./pty-interception.js";
import type { ShellKind } from "./shell-resolver.js";

/**
 * Formatting-neutral refusal message: an internal newline between the two
 * sentences but NO trailing newline -- the public dispatch (4f) decides how to
 * print it.
 */
function formatUnsupportedShellMessage(detectedShellKind: string): string {
  return (
    "viberevert shell --pty only supports bash command interception right now; " +
    `the resolved interactive shell is "${detectedShellKind}".\n` +
    "Use `viberevert shell` for the guarded command loop."
  );
}

/**
 * Classify a resolved shell for interception. `bash` -> supported; ANYTHING else
 * (powershell, posix, or a future ShellKind) -> refused with the detected kind.
 * The `if bash else refuse` shape -- NOT an exhaustive switch -- is the fail-closed
 * default: a new shell family stays unsupported until hook support is added.
 */
export function resolveInterceptionShellSupport(shellKind: ShellKind): InterceptionShellSupport {
  if (shellKind === "bash") {
    return { kind: "supported", shellKind: "bash" };
  }

  const detectedShellKind = shellKind;
  return {
    kind: "refused",
    reason: "unsupported_shell",
    detectedShellKind,
    message: formatUnsupportedShellMessage(detectedShellKind),
  };
}
