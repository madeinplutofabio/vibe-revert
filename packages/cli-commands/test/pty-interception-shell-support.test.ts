// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// M G4 Step 4c: the interception hook capability matrix. Pure -- bash is the only
// interception-capable shell; powershell / posix / any future ShellKind fail
// closed (refused with the detected kind + a formatting-neutral message).

import { describe, expect, it } from "vitest";

import { resolveInterceptionShellSupport } from "../src/commands/pty-interception-shell-support.js";
import type { ShellKind } from "../src/commands/shell-resolver.js";

describe("resolveInterceptionShellSupport (M G4 Step 4c)", () => {
  it("supports bash (and leaks no message/detectedShellKind)", () => {
    expect(resolveInterceptionShellSupport("bash")).toEqual({
      kind: "supported",
      shellKind: "bash",
    });
  });

  const refusedKinds: ShellKind[] = ["powershell", "posix"];
  it.each(refusedKinds)("refuses %s as unsupported_shell with the detected kind", (shellKind) => {
    const support = resolveInterceptionShellSupport(shellKind);
    expect(support.kind).toBe("refused");
    if (support.kind === "refused") {
      expect(support.reason).toBe("unsupported_shell");
      expect(support.detectedShellKind).toBe(shellKind);
      expect(support.message).toContain("bash");
      expect(support.message).toContain(shellKind);
      expect(support.message).toContain("`viberevert shell`");
      expect(support.message.endsWith("\n")).toBe(false); // formatting-neutral: no trailing newline
    }
  });

  it("fails closed for an unknown/future ShellKind, echoing it verbatim with the exact message", () => {
    const unknown = "zsh" as ShellKind;
    expect(resolveInterceptionShellSupport(unknown)).toEqual({
      kind: "refused",
      reason: "unsupported_shell",
      detectedShellKind: "zsh",
      message:
        "viberevert shell --pty only supports bash command interception right now; " +
        'the resolved interactive shell is "zsh".\n' +
        "Use `viberevert shell` for the guarded command loop.",
    });
  });
});
