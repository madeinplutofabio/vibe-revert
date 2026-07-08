// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the PTY engine host wiring + precondition gate (M G4 Step 3c).
//
// resolveHostInteractiveShell bridges the pure resolver and the executable path
// resolver through ONE injected `resolveExecutablePath`, cached so the approved
// path equals the one availability accepted, then re-verified as an exact path.
// evaluatePtyPreconditions is the fail-fast pre-spawn gate. Both take injected
// deps (all-or-none) -- deterministic, no node-pty/TTY/fs.

import { describe, expect, it } from "vitest";

import type { PtyDisposable, PtyModule, PtyProcess } from "../src/commands/pty-loader.js";
import {
  evaluatePtyPreconditions,
  type ResolvedInteractiveShell,
  resolveHostInteractiveShell,
} from "../src/commands/shell-pty.js";

/**
 * Build a fake `resolveExecutablePath` that models the real one: each
 * `[input, resolved]` entry maps the bare/absolute input to its resolved path,
 * AND every resolved (exact) path resolves to itself (an absolute executable
 * verifies as itself). Anything else -> null. This mirrors the exact-path
 * re-verify the resolver performs.
 */
function resolverFromEntries(
  entries: readonly [string, string][],
): (file: string) => string | null {
  const byInput = new Map(entries);
  const exactPaths = new Set(entries.map(([, resolved]) => resolved));
  return (file) => {
    if (byInput.has(file)) {
      return byInput.get(file) ?? null;
    }
    return exactPaths.has(file) ? file : null;
  };
}

const noopDisposable: PtyDisposable = { dispose: () => undefined };
const fakePtyProcess: PtyProcess = {
  write: () => undefined,
  resize: () => undefined,
  kill: () => undefined,
  onData: () => noopDisposable,
  onExit: () => noopDisposable,
};
const fakePty: PtyModule = { spawn: () => fakePtyProcess };
const fakeShell: ResolvedInteractiveShell = { path: "/bin/bash", args: ["-i"], kind: "bash" };

describe("resolveHostInteractiveShell -- resolver + path resolver via one seam", () => {
  it("resolves a POSIX bash to its exact path", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { PATH: "/usr/bin:/bin" },
      resolveExecutablePath: resolverFromEntries([["bash", "/bin/bash"]]),
    });
    expect(result).toEqual({ path: "/bin/bash", args: ["-i"], kind: "bash" });
  });

  it("resolves an absolute non-bash $SHELL to its exact path (kind posix)", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { SHELL: "/usr/bin/zsh", PATH: "/usr/bin" },
      resolveExecutablePath: resolverFromEntries([["/usr/bin/zsh", "/usr/bin/zsh"]]),
    });
    expect(result).toEqual({ path: "/usr/bin/zsh", args: ["-i"], kind: "posix" });
  });

  it("prefers pwsh on Windows and resolves its exact path", () => {
    const pwshPath = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const result = resolveHostInteractiveShell({
      platform: "win32",
      env: {},
      resolveExecutablePath: resolverFromEntries([["pwsh", pwshPath]]),
    });
    expect(result).toEqual({ path: pwshPath, args: ["-NoLogo"], kind: "powershell" });
  });

  it("falls back to powershell.exe on Windows when pwsh is absent", () => {
    const psPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const result = resolveHostInteractiveShell({
      platform: "win32",
      env: {},
      resolveExecutablePath: resolverFromEntries([["powershell.exe", psPath]]),
    });
    expect(result).toEqual({ path: psPath, args: ["-NoLogo"], kind: "powershell" });
  });

  it("returns null when no suitable shell is available", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: {},
      resolveExecutablePath: resolverFromEntries([]),
    });
    expect(result).toBeNull();
  });

  it("treats undefined SHELL as omitted when adapting ProcessEnv for the pure resolver", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { SHELL: undefined, PATH: "/bin" },
      resolveExecutablePath: resolverFromEntries([["bash", "/bin/bash"]]),
    });
    expect(result).toEqual({ path: "/bin/bash", args: ["-i"], kind: "bash" });
  });

  it("returns the same path that availability approved, not a later PATH candidate", () => {
    let bashCalls = 0;
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { PATH: "/usr/bin:/bin" },
      resolveExecutablePath: (file) => {
        if (file === "bash") {
          bashCalls += 1;
          return bashCalls === 1 ? "/usr/bin/bash" : "/bin/bash";
        }
        return file === "/usr/bin/bash" ? "/usr/bin/bash" : null;
      },
    });
    expect(result).toEqual({ path: "/usr/bin/bash", args: ["-i"], kind: "bash" });
  });

  it("refuses if the approved exact path no longer verifies", () => {
    const result = resolveHostInteractiveShell({
      platform: "linux",
      env: { PATH: "/bin" },
      resolveExecutablePath: (file) => {
        if (file === "bash") {
          return "/bin/bash";
        }
        return null; // exact /bin/bash verification fails
      },
    });
    expect(result).toBeNull();
  });
});

describe("evaluatePtyPreconditions -- pre-spawn gate", () => {
  it("refuses not_tty first, before loading the PTY module or resolving a shell", async () => {
    let loadCalls = 0;
    let shellCalls = 0;

    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => false,
      loadPtyModule: async () => {
        loadCalls += 1;
        return fakePty;
      },
      resolveHostShell: () => {
        shellCalls += 1;
        return fakeShell;
      },
    });

    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("not_tty");
      expect(result.exitCode).toBe(1);
    }
    expect(loadCalls).toBe(0);
    expect(shellCalls).toBe(0);
  });

  it("refuses pty_unavailable when the PTY module is absent", async () => {
    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => null,
      resolveHostShell: () => fakeShell,
    });
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("pty_unavailable");
      expect(result.exitCode).toBe(1);
    }
  });

  it("refuses pty_unavailable (fail-closed) when the loader throws", async () => {
    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => {
        throw new Error("native binding blew up");
      },
      resolveHostShell: () => fakeShell,
    });
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("pty_unavailable");
      expect(result.exitCode).toBe(1);
    }
  });

  it("refuses no_shell when no suitable shell resolves", async () => {
    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => fakePty,
      resolveHostShell: () => null,
    });
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("no_shell");
      expect(result.exitCode).toBe(1);
    }
  });

  it("checks the PTY module before the shell (pty_unavailable short-circuits no_shell)", async () => {
    let shellCalls = 0;

    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => null,
      resolveHostShell: () => {
        shellCalls += 1;
        return null;
      },
    });

    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.reason).toBe("pty_unavailable");
    }
    expect(shellCalls).toBe(0);
  });

  it("proceeds with the loaded PTY module and resolved shell when all checks pass", async () => {
    const result = await evaluatePtyPreconditions({
      hasInteractiveTty: () => true,
      loadPtyModule: async () => fakePty,
      resolveHostShell: () => fakeShell,
    });
    expect(result.kind).toBe("proceed");
    if (result.kind === "proceed") {
      expect(result.pty).toBe(fakePty);
      expect(result.shell).toEqual(fakeShell);
    }
  });
});
