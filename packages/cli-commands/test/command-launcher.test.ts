// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Pure tests for the command launch-plan builder (M H11.1, ADR 0005).
//
// Host-independent: `buildCommandLaunchPlan` takes an injected `platform`, so
// Windows logic is exercised on any OS (like executable-probe.test.ts). No
// process is spawned here. Runtime guarantees live in the Windows live suite
// (`command-launcher-windows-live.test.ts`).
//
// Guarantee → proven by:
//   classification .......................... this file (pure)
//   input validation + ordering ............. this file (pure)
//   rejection policy ........................ this file (pure)
//   defensive argument copy ................. this file (pure)
//   cmd.exe command-line CONSTRUCTION ....... this file (pure)
//   argument fidelity (transport) ........... windows-live
//   injection resistance (accepted subset) .. windows-live
//   exit vs spawn-error distinction ......... windows-live
//   stdout/stderr attachment ................ windows-live
//   signals + scoped teardown ............... windows-live (lifecycle spike)
//   resolve-before-launch selects exact path  windows-live (A-vs-B)
//   native direct-spawn runtime preserved ... windows-live
//   non-Windows runtime unchanged ........... existing run tests / H11.2 regression

import { describe, expect, it } from "vitest";

import {
  type BuildCommandLaunchPlanInput,
  buildCommandLaunchPlan,
  type CommandLaunchPlan,
} from "../src/commands/command-launcher.js";

/** One backslash — used to keep backslash-count assertions readable. */
const BS = "\\";
/** A plausible absolute cmd.exe for pure Windows tests (never spawned). */
const CMD = `C:${BS}Windows${BS}System32${BS}cmd.exe`;

function plan(overrides: Partial<BuildCommandLaunchPlanInput> & { platform: NodeJS.Platform }) {
  return buildCommandLaunchPlan({
    resolvedTarget: null,
    requestedCommand: "agent",
    args: [],
    ...overrides,
  });
}

/** Narrow to a windows-cmd plan via the discriminator (no unsafe cast). */
function windowsCmdPlan(
  overrides: Partial<BuildCommandLaunchPlanInput>,
): Extract<CommandLaunchPlan, { kind: "windows-cmd" }> {
  const r = plan({
    platform: "win32",
    resolvedTarget: `C:${BS}a${BS}agent.cmd`,
    resolvedComSpec: CMD,
    ...overrides,
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("expected ok");
  expect(r.plan.kind).toBe("windows-cmd");
  if (r.plan.kind !== "windows-cmd") throw new Error("expected windows-cmd plan");
  return r.plan;
}

/** The `<inner>` command line, without the outer `/s` quote pair the plan adds. */
function innerCommandLine(p: Extract<CommandLaunchPlan, { kind: "windows-cmd" }>): string {
  expect(p.args).toHaveLength(5);
  const outer = p.args[4];
  if (outer === undefined) {
    throw new Error("windows-cmd plan is missing its candidate command line");
  }
  expect(outer.startsWith('"')).toBe(true);
  expect(outer.endsWith('"')).toBe(true);
  return outer.slice(1, -1);
}

describe("buildCommandLaunchPlan — request + argument validation", () => {
  it("rejects an empty requested command first", () => {
    expect(plan({ platform: "linux", requestedCommand: "", resolvedTarget: "/bin/agent" })).toEqual(
      {
        ok: false,
        error: "invalid-requested-command",
        reason: "empty",
      },
    );
  });

  it("rejects control characters in the requested command", () => {
    expect(
      plan({ platform: "linux", requestedCommand: "a\nb", resolvedTarget: "/bin/agent" }),
    ).toEqual({
      ok: false,
      error: "invalid-requested-command",
      reason: "contains-control-character",
    });
  });

  it("reports command-not-found for an unresolved target", () => {
    expect(plan({ platform: "linux", resolvedTarget: null })).toEqual({
      ok: false,
      error: "command-not-found",
      requestedCommand: "agent",
    });
  });

  it("rejects an empty resolved target", () => {
    expect(plan({ platform: "linux", resolvedTarget: "" })).toEqual({
      ok: false,
      error: "invalid-resolved-target",
      resolvedTarget: "",
      reason: "empty",
    });
  });

  it("rejects a non-absolute resolved target", () => {
    expect(plan({ platform: "linux", resolvedTarget: "agent" })).toEqual({
      ok: false,
      error: "invalid-resolved-target",
      resolvedTarget: "agent",
      reason: "not-absolute",
    });
  });

  it("rejects control characters in a resolved target", () => {
    expect(plan({ platform: "linux", resolvedTarget: "/bin/a\0b" })).toEqual({
      ok: false,
      error: "invalid-resolved-target",
      resolvedTarget: "/bin/a\0b",
      reason: "contains-control-character",
    });
  });

  it("rejects NUL in any argument, before launch selection", () => {
    expect(plan({ platform: "linux", resolvedTarget: "/bin/agent", args: ["ok", "a\0b"] })).toEqual(
      {
        ok: false,
        error: "invalid-argument",
        argumentIndex: 1,
        reason: "contains-nul",
      },
    );
  });

  it("allows CR/LF arguments on the direct path", () => {
    expect(plan({ platform: "linux", resolvedTarget: "/bin/agent", args: ["a\nb"] }).ok).toBe(true);
  });
});

describe("buildCommandLaunchPlan — validation ordering (security-significant)", () => {
  it("invalid requested command wins over an unresolved target", () => {
    expect(plan({ platform: "linux", requestedCommand: "", resolvedTarget: null })).toEqual({
      ok: false,
      error: "invalid-requested-command",
      reason: "empty",
    });
  });

  it("unresolved target wins over a NUL argument", () => {
    expect(plan({ platform: "linux", resolvedTarget: null, args: ["a\0b"] })).toEqual({
      ok: false,
      error: "command-not-found",
      requestedCommand: "agent",
    });
  });

  it("a NUL argument is reported for an otherwise-valid native target", () => {
    expect(
      plan({ platform: "win32", resolvedTarget: `C:${BS}a${BS}agent.exe`, args: ["a\0b"] }),
    ).toEqual({ ok: false, error: "invalid-argument", argumentIndex: 0, reason: "contains-nul" });
  });
});

describe("buildCommandLaunchPlan — classification", () => {
  it("POSIX resolved target → direct plan with the resolved path", () => {
    expect(plan({ platform: "linux", resolvedTarget: "/usr/bin/agent", args: ["--x"] })).toEqual({
      ok: true,
      plan: {
        kind: "direct",
        strategy: "direct-v1",
        command: "/usr/bin/agent",
        args: ["--x"],
        shell: false,
        requestedCommand: "agent",
        resolvedTarget: "/usr/bin/agent",
      },
    });
  });

  it("Windows .exe and .com → direct plan", () => {
    for (const ext of [".exe", ".com"]) {
      const r = plan({ platform: "win32", resolvedTarget: `C:${BS}a${BS}agent${ext}` });
      expect(r.ok && r.plan.kind === "direct").toBe(true);
    }
  });

  it("Windows .cmd → windows-cmd plan", () => {
    expect(windowsCmdPlan({}).kind).toBe("windows-cmd");
  });

  it("classifies Windows extensions case-insensitively", () => {
    expect(
      plan({ platform: "win32", resolvedTarget: `C:${BS}a${BS}agent.CMD`, resolvedComSpec: CMD }),
    ).toMatchObject({ ok: true, plan: { kind: "windows-cmd" } });
    expect(plan({ platform: "win32", resolvedTarget: `C:${BS}a${BS}agent.EXE` })).toMatchObject({
      ok: true,
      plan: { kind: "direct" },
    });
  });

  it("accepts an absolute UNC .cmd target", () => {
    const target = `${BS}${BS}server${BS}share${BS}agent.cmd`;
    expect(plan({ platform: "win32", resolvedTarget: target, resolvedComSpec: CMD })).toMatchObject(
      {
        ok: true,
        plan: { kind: "windows-cmd", resolvedTarget: target },
      },
    );
  });

  it.each([
    [".bat", "batch-file"],
    [".ps1", "powershell-script"],
    [".js", "script"],
    [".vbs", "script"],
    [".weird", "unknown"],
  ])("Windows %s → unsupported-target (%s)", (ext, targetKind) => {
    const t = `C:${BS}a${BS}agent${ext}`;
    expect(plan({ platform: "win32", resolvedTarget: t, resolvedComSpec: CMD })).toEqual({
      ok: false,
      error: "unsupported-target",
      resolvedTarget: t,
      targetKind,
    });
  });

  it("Windows extension-less target → unsupported-target (extensionless)", () => {
    const t = `C:${BS}a${BS}agent`;
    expect(plan({ platform: "win32", resolvedTarget: t, resolvedComSpec: CMD })).toEqual({
      ok: false,
      error: "unsupported-target",
      resolvedTarget: t,
      targetKind: "extensionless",
    });
  });
});

describe("buildCommandLaunchPlan — defensive argument copy", () => {
  it("does not reflect later mutation of the caller's array (direct)", () => {
    const args = ["before"];
    const r = plan({ platform: "linux", resolvedTarget: "/bin/agent", args });
    expect(r.ok).toBe(true);
    args[0] = "after";
    if (!r.ok) return;
    expect(r.plan.args).toEqual(["before"]);
  });

  it("does not reflect later mutation of the caller's array (windows-cmd)", () => {
    const args = ["before"];
    const p = windowsCmdPlan({ args });
    args[0] = "after";
    expect(innerCommandLine(p)).toBe(`"C:${BS}a${BS}agent.cmd" "before"`);
  });
});

describe("buildCommandLaunchPlan — windows-cmd construction", () => {
  it("has the candidate cmd.exe shape, flags, verbatim flag, and assumptions", () => {
    const p = windowsCmdPlan({
      requestedCommand: "agent",
      resolvedTarget: `C:${BS}Program Files${BS}a${BS}agent.cmd`,
      args: ["one", "two three"],
    });
    expect(p.command).toBe(CMD);
    expect(p.shell).toBe(false);
    expect(p.windowsVerbatimArguments).toBe(true);
    expect(p.requestedCommand).toBe("agent");
    expect(p.resolvedTarget).toBe(`C:${BS}Program Files${BS}a${BS}agent.cmd`);
    expect(p.assumptions).toEqual({
      autoRunDisabled: true,
      delayedExpansionDisabled: true,
      nodeArgumentQuotingDisabled: true,
    });
    expect(p.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(innerCommandLine(p)).toBe(
      `"C:${BS}Program Files${BS}a${BS}agent.cmd" "one" "two three"`,
    );
  });

  it("quotes spaces, shell metacharacters, empty args, and slash-prefixed args", () => {
    const p = windowsCmdPlan({ args: ["a & b | c < d > e", "(f)^g", "", "/c", "/v:on", "/?"] });
    expect(innerCommandLine(p)).toBe(
      `"C:${BS}a${BS}agent.cmd" "a & b | c < d > e" "(f)^g" "" "/c" "/v:on" "/?"`,
    );
  });

  it("doubles a trailing backslash run of length 1, 2, and 3", () => {
    const p = windowsCmdPlan({ args: [`x${BS}`, `x${BS}${BS}`, `x${BS}${BS}${BS}`] });
    expect(innerCommandLine(p)).toBe(
      `"C:${BS}a${BS}agent.cmd" "x${BS}${BS}" "x${BS}${BS}${BS}${BS}" "x${BS}${BS}${BS}${BS}${BS}${BS}"`,
    );
  });

  it("preserves Unicode (BMP, non-BMP, combining) verbatim in the quoted arg", () => {
    const p = windowsCmdPlan({ args: ["日本語", "😀", "é"] });
    expect(innerCommandLine(p)).toBe(`"C:${BS}a${BS}agent.cmd" "日本語" "😀" "é"`);
  });
});

describe("buildCommandLaunchPlan — ComSpec validation", () => {
  const base = { platform: "win32" as const, resolvedTarget: `C:${BS}a${BS}agent.cmd` };

  it("missing → comspec-not-found", () => {
    expect(plan(base)).toEqual({ ok: false, error: "comspec-not-found" });
  });

  it("control characters → invalid-comspec/contains-control-character", () => {
    const c = `${CMD}\n`;
    expect(plan({ ...base, resolvedComSpec: c })).toEqual({
      ok: false,
      error: "invalid-comspec",
      resolvedComSpec: c,
      reason: "contains-control-character",
    });
  });

  it("non-absolute → invalid-comspec/not-absolute", () => {
    expect(plan({ ...base, resolvedComSpec: "cmd.exe" })).toEqual({
      ok: false,
      error: "invalid-comspec",
      resolvedComSpec: "cmd.exe",
      reason: "not-absolute",
    });
  });

  it("non-cmd.exe interpreter → invalid-comspec/unsupported-interpreter", () => {
    const ps = `C:${BS}Windows${BS}System32${BS}WindowsPowerShell${BS}v1.0${BS}powershell.exe`;
    expect(plan({ ...base, resolvedComSpec: ps })).toEqual({
      ok: false,
      error: "invalid-comspec",
      resolvedComSpec: ps,
      reason: "unsupported-interpreter",
    });
  });

  it("accepts cmd.exe case-insensitively", () => {
    const r = plan({ ...base, resolvedComSpec: `C:${BS}Windows${BS}System32${BS}CMD.EXE` });
    expect(r.ok && r.plan.kind === "windows-cmd").toBe(true);
  });
});

describe("buildCommandLaunchPlan — cmd argument + target rejection", () => {
  const base = {
    platform: "win32" as const,
    resolvedTarget: `C:${BS}a${BS}agent.cmd`,
    resolvedComSpec: CMD,
  };

  it.each([
    ['"', 0x22],
    ["%", 0x25],
    ["!", 0x21],
    ["\r", 0x0d],
    ["\n", 0x0a],
  ])("rejects an argument containing %j (unsafe-windows-cmd-argument)", (ch, cp) => {
    expect(plan({ ...base, args: ["ok", `x${ch}y`] })).toEqual({
      ok: false,
      error: "unsafe-windows-cmd-argument",
      subject: "argument",
      argumentIndex: 1,
      rejectedCodePoint: cp,
    });
  });

  it.each([
    ['"', 0x22],
    ["%", 0x25],
    ["!", 0x21],
  ])("rejects %j in the .cmd target path (subject: target)", (ch, cp) => {
    const target = `C:${BS}a${BS}x${ch}y.cmd`;
    expect(plan({ ...base, resolvedTarget: target })).toEqual({
      ok: false,
      error: "unsafe-windows-cmd-argument",
      subject: "target",
      rejectedCodePoint: cp,
    });
  });

  it.each([
    "\r",
    "\n",
  ])("rejects %j in the .cmd target as invalid-resolved-target (universal path validation precedes cmd rejection)", (ch) => {
    const target = `C:${BS}a${BS}x${ch}y.cmd`;
    expect(plan({ ...base, resolvedTarget: target })).toEqual({
      ok: false,
      error: "invalid-resolved-target",
      resolvedTarget: target,
      reason: "contains-control-character",
    });
  });
});
