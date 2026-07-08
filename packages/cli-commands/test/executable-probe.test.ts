// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure executable path resolver + probe (M G4 Step 3b, D104.N).
//
// Both are pure factories: platform + env + an injected fileIsExecutable(path).
// Tests inject all three, so PATH scanning is deterministic and host-independent
// (path.win32 / path.posix exercised regardless of the host OS). The host
// wrappers (real fs) are the thin impure seam and are not exercised here.

import { describe, expect, it } from "vitest";

import {
  createExecutablePathResolver,
  createExecutableProbe,
} from "../src/commands/executable-probe.js";

/** Build a boolean probe from a fixed set of "present" paths and query `file`. */
function check(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  executablePaths: string[],
  file: string,
): boolean {
  const set = new Set(executablePaths);
  const probe = createExecutableProbe({
    platform,
    env,
    fileIsExecutable: (candidatePath) => set.has(candidatePath),
  });
  return probe(file);
}

/** Build a path resolver from a fixed set of "present" paths and query `file`. */
function resolvePath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  executablePaths: string[],
  file: string,
): string | null {
  const set = new Set(executablePaths);
  const resolve = createExecutablePathResolver({
    platform,
    env,
    fileIsExecutable: (candidatePath) => set.has(candidatePath),
  });
  return resolve(file);
}

describe("createExecutableProbe -- POSIX", () => {
  it("checks an absolute path directly (found)", () => {
    expect(check("linux", {}, ["/bin/bash"], "/bin/bash")).toBe(true);
  });

  it("checks an absolute path directly (absent)", () => {
    expect(check("linux", {}, [], "/bin/bash")).toBe(false);
  });

  it("finds a bare name across PATH entries", () => {
    expect(check("linux", { PATH: "/usr/bin:/bin" }, ["/bin/bash"], "bash")).toBe(true);
  });

  it("returns false when a bare name is not on PATH", () => {
    expect(check("linux", { PATH: "/usr/bin:/bin" }, [], "bash")).toBe(false);
  });

  it("splits PATH on ':' regardless of host (path.posix)", () => {
    expect(check("linux", { PATH: "/a:/b" }, ["/b/tool"], "tool")).toBe(true);
  });

  it("ignores PATHEXT on POSIX (no extension appended)", () => {
    expect(check("linux", { PATH: "/a", PATHEXT: ".EXE" }, ["/a/tool.EXE"], "tool")).toBe(false);
  });

  it("honors only PATH on POSIX -- ignores Path/path (case-sensitive env)", () => {
    expect(check("linux", { Path: "/a", path: "/a" }, ["/a/bash"], "bash")).toBe(false);
  });

  it("skips empty PATH entries -- never searches the current directory", () => {
    // If the empty entry were searched, "bash" (cwd-relative) would match.
    expect(check("linux", { PATH: "/usr/bin::/bin" }, ["bash"], "bash")).toBe(false);
    expect(check("linux", { PATH: "" }, ["bash"], "bash")).toBe(false);
    expect(check("linux", {}, ["bash"], "bash")).toBe(false);
  });

  it("rejects relative paths with separators instead of PATH-joining them", () => {
    expect(check("linux", { PATH: "/bin" }, ["/bin/./bash"], "./bash")).toBe(false);
    expect(check("linux", { PATH: "/bin" }, ["/bin/tools/bash"], "tools/bash")).toBe(false);
  });

  it("returns false for an empty file name", () => {
    expect(check("linux", { PATH: "/bin" }, ["/bin/"], "")).toBe(false);
  });
});

describe("createExecutableProbe -- Windows", () => {
  it("checks a fully qualified Windows absolute path directly", () => {
    const abs = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(check("win32", {}, [abs], abs)).toBe(true);
  });

  it("finds a name that already carries its extension (bare-first)", () => {
    expect(
      check(
        "win32",
        { PATH: "C:\\Windows\\System32", PATHEXT: ".COM;.EXE" },
        ["C:\\Windows\\System32\\powershell.exe"],
        "powershell.exe",
      ),
    ).toBe(true);
  });

  it("appends a PATHEXT extension for an extension-less name", () => {
    expect(
      check("win32", { PATH: "C:\\pwsh", PATHEXT: ".EXE" }, ["C:\\pwsh\\pwsh.EXE"], "pwsh"),
    ).toBe(true);
  });

  it("does not append PATHEXT when the name already has a known extension (no foo.exe.EXE)", () => {
    expect(
      check("win32", { PATH: "C:\\a", PATHEXT: ".EXE" }, ["C:\\a\\tool.exe.EXE"], "tool.exe"),
    ).toBe(false);
  });

  it("uses a default PATHEXT when it is unset", () => {
    expect(check("win32", { PATH: "C:\\p" }, ["C:\\p\\pwsh.EXE"], "pwsh")).toBe(true);
  });

  it("splits PATH on ';' regardless of host (path.win32)", () => {
    expect(
      check("win32", { PATH: "C:\\a;C:\\b", PATHEXT: ".EXE" }, ["C:\\b\\tool.EXE"], "tool"),
    ).toBe(true);
  });

  it("skips empty PATH entries on Windows too", () => {
    expect(check("win32", { PATH: "C:\\a;;C:\\b", PATHEXT: ".EXE" }, ["tool.EXE"], "tool")).toBe(
      false,
    );
  });

  it("honors Windows Path casing as well as PATH", () => {
    expect(
      check("win32", { Path: "C:\\pwsh", PATHEXT: ".EXE" }, ["C:\\pwsh\\pwsh.EXE"], "pwsh"),
    ).toBe(true);
  });

  it("honors Windows PathExt casing as well as PATHEXT", () => {
    expect(
      check("win32", { PATH: "C:\\pwsh", PathExt: ".EXE" }, ["C:\\pwsh\\pwsh.EXE"], "pwsh"),
    ).toBe(true);
  });

  it("honors lowercase Windows path and pathext casing for copied env objects", () => {
    expect(
      check("win32", { path: "C:\\pwsh", pathext: "EXE" }, ["C:\\pwsh\\pwsh.EXE"], "pwsh"),
    ).toBe(true);
  });

  it("rejects relative paths with Windows separators (backslash or forward slash)", () => {
    expect(
      check(
        "win32",
        { PATH: "C:\\Tools", PATHEXT: ".EXE" },
        ["C:\\Tools\\bin\\pwsh.EXE"],
        "bin\\pwsh",
      ),
    ).toBe(false);
    expect(
      check(
        "win32",
        { PATH: "C:\\Tools", PATHEXT: ".EXE" },
        ["C:\\Tools\\bin\\pwsh.EXE"],
        "bin/pwsh",
      ),
    ).toBe(false);
  });

  it("de-duplicates PATHEXT case-insensitively", () => {
    const tried: string[] = [];
    const probe = createExecutableProbe({
      platform: "win32",
      env: { PATH: "C:\\a", PATHEXT: ".EXE;.exe;.EXE" },
      fileIsExecutable: (candidatePath) => {
        tried.push(candidatePath);
        return false;
      },
    });
    expect(probe("pwsh")).toBe(false);
    expect(tried).toEqual(["C:\\a\\pwsh", "C:\\a\\pwsh.EXE"]);
  });
});

describe("createExecutablePathResolver -- returns the exact approved path", () => {
  it("resolves a bare POSIX name to its PATH candidate", () => {
    expect(resolvePath("linux", { PATH: "/usr/bin:/bin" }, ["/bin/bash"], "bash")).toBe(
      "/bin/bash",
    );
  });

  it("resolves a bare Windows name to its PATH+PATHEXT candidate", () => {
    expect(
      resolvePath("win32", { PATH: "C:\\pwsh", PATHEXT: ".EXE" }, ["C:\\pwsh\\pwsh.EXE"], "pwsh"),
    ).toBe("C:\\pwsh\\pwsh.EXE");
  });

  it("resolves an absolute path to itself", () => {
    expect(resolvePath("linux", {}, ["/opt/bin/bash"], "/opt/bin/bash")).toBe("/opt/bin/bash");
  });

  it("returns null for a relative path with separators", () => {
    expect(resolvePath("linux", { PATH: "/bin" }, ["/bin/bash"], "./bash")).toBeNull();
  });

  it("rejects Windows root-relative paths because they are current-drive relative, not exact", () => {
    const rootRelative = "\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(resolvePath("win32", {}, [rootRelative], rootRelative)).toBeNull();
  });

  it("accepts fully qualified Windows UNC paths directly", () => {
    const unc = "\\\\server\\share\\pwsh.exe";
    expect(resolvePath("win32", {}, [unc], unc)).toBe(unc);
  });

  it("returns null when nothing matches", () => {
    expect(resolvePath("linux", { PATH: "/bin" }, [], "bash")).toBeNull();
  });
});
