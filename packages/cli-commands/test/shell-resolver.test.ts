// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure interactive-shell resolver (M G4 Step 3, D104.N).
//
// The resolver is a pure decision function: platform + env + an injected
// "is this executable available?" probe -> {file,args,kind} or null. These
// tests mock all three inputs, so they are deterministic and independent of
// the host OS -- no spawning, no PATH, no filesystem.

import { describe, expect, it } from "vitest";

import { resolveInteractiveShell, type ShellResolverEnv } from "../src/commands/shell-resolver.js";

/** An availability probe that reports exactly `files` as present. */
function availableSet(...files: string[]): (file: string) => boolean {
  const set = new Set(files);
  return (file) => set.has(file);
}

/** Resolve with an explicit platform/env and a fixed available-executable set. */
function resolve(platform: NodeJS.Platform, env: ShellResolverEnv, ...available: string[]) {
  return resolveInteractiveShell({
    platform,
    env,
    isExecutableAvailable: availableSet(...available),
  });
}

describe("resolveInteractiveShell -- Windows (pwsh -> powershell.exe -> null; never cmd.exe)", () => {
  it("prefers pwsh when available", () => {
    expect(resolve("win32", {}, "pwsh", "powershell.exe")).toEqual({
      file: "pwsh",
      args: ["-NoLogo"],
      kind: "powershell",
    });
  });

  it("falls back to powershell.exe when pwsh is absent", () => {
    expect(resolve("win32", {}, "powershell.exe")).toEqual({
      file: "powershell.exe",
      args: ["-NoLogo"],
      kind: "powershell",
    });
  });

  it("returns null when neither PowerShell is available", () => {
    expect(resolve("win32", {})).toBeNull();
  });

  it("never selects cmd.exe -- returns null even when only cmd.exe is available", () => {
    expect(resolve("win32", {}, "cmd.exe")).toBeNull();
  });

  it("ignores $SHELL on Windows", () => {
    // $SHELL is a POSIX concept; Windows resolution must not consult it.
    expect(resolve("win32", { SHELL: "/bin/bash" }, "powershell.exe")).toEqual({
      file: "powershell.exe",
      args: ["-NoLogo"],
      kind: "powershell",
    });
  });
});

describe("resolveInteractiveShell -- POSIX ($SHELL -> bash -> null; no sh fallback)", () => {
  it("treats every non-win32 platform as POSIX", () => {
    // Guards against someone narrowing POSIX routing to only linux/darwin.
    expect(resolve("freebsd", {}, "bash")).toEqual({
      file: "bash",
      args: ["-i"],
      kind: "bash",
    });
  });

  it("uses an absolute, available $SHELL and tags a bash path as kind bash", () => {
    expect(resolve("linux", { SHELL: "/bin/bash" }, "/bin/bash")).toEqual({
      file: "/bin/bash",
      args: ["-i"],
      kind: "bash",
    });
  });

  it("honors a custom absolute bash location as kind bash", () => {
    expect(
      resolve("darwin", { SHELL: "/opt/homebrew/bin/bash" }, "/opt/homebrew/bin/bash"),
    ).toEqual({ file: "/opt/homebrew/bin/bash", args: ["-i"], kind: "bash" });
  });

  it("resolves a non-bash absolute $SHELL as kind posix (Step 4 gates it, not the resolver)", () => {
    expect(resolve("linux", { SHELL: "/usr/bin/zsh" }, "/usr/bin/zsh")).toEqual({
      file: "/usr/bin/zsh",
      args: ["-i"],
      kind: "posix",
    });
  });

  it("honors an explicit absolute $SHELL=/bin/sh as kind posix (then Step-4-gated)", () => {
    // Distinct from the no-IMPLICIT-sh-fallback rule below: an explicit
    // absolute $SHELL is honored; guardability is Step 4's call.
    expect(resolve("linux", { SHELL: "/bin/sh" }, "/bin/sh")).toEqual({
      file: "/bin/sh",
      args: ["-i"],
      kind: "posix",
    });
  });

  it("falls back to bash when $SHELL is a relative/bare value", () => {
    expect(resolve("linux", { SHELL: "bash" }, "bash")).toEqual({
      file: "bash",
      args: ["-i"],
      kind: "bash",
    });
  });

  it("falls back to bash when $SHELL is absolute but not available", () => {
    expect(resolve("linux", { SHELL: "/usr/bin/fish" }, "bash")).toEqual({
      file: "bash",
      args: ["-i"],
      kind: "bash",
    });
  });

  it("falls back to bash when $SHELL is empty", () => {
    expect(resolve("linux", { SHELL: "" }, "bash")).toEqual({
      file: "bash",
      args: ["-i"],
      kind: "bash",
    });
  });

  it("uses bash when $SHELL is unset", () => {
    expect(resolve("darwin", {}, "bash")).toEqual({
      file: "bash",
      args: ["-i"],
      kind: "bash",
    });
  });

  it("returns null when neither a usable $SHELL nor bash is available (NO sh fallback)", () => {
    // sh present but bash absent and no usable $SHELL -> null, never sh.
    expect(resolve("linux", {}, "sh")).toBeNull();
  });

  it("returns null when nothing is available", () => {
    expect(resolve("linux", {})).toBeNull();
  });
});
