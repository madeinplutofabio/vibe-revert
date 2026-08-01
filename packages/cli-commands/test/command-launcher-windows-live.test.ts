// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Windows live spike for the command launch-plan builder (M H11.1, ADR 0005).
//
// Empirically validates the CANDIDATE cmd.exe construction (File 3) against a
// representative Node-forwarding package-manager shim shape (a `.cmd` forwarding
// `%*` to a node arg-dumper), in a tmpdir path containing a SPACE. A test-only,
// NON-EXPORTED executor spawns the returned plan; production wiring is H11.2.
// Proves: argument fidelity (transport), accepted-subset injection resistance,
// exit-code propagation, exit-vs-spawn-error distinction, stdout/stderr, cwd
// behavior, conservative pre-launch rejection, resolve-before-launch (A-vs-B),
// and preserved native direct spawning.
//
// DEFERRED: signal delivery and scoped process-tree teardown — those must test
// the actual `run` termination mechanism and are a separate bounded spike. The
// timeout cleanup below is a HARNESS SAFEGUARD ONLY, not lifecycle evidence.
//
// BOUNDED CONFORMANCE: proves behavior only for this runner's Windows build,
// Node (`process.execPath`), and `cmd.exe`, with delayed expansion off.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, release, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  buildCommandLaunchPlan,
  type CommandLaunchPlan,
} from "../src/commands/command-launcher.js";
import { createExecutablePathResolver } from "../src/commands/executable-probe.js";

const IS_WINDOWS = process.platform === "win32";
const EXECUTION_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 25_000;
const TASKKILL_TIMEOUT_MS = 3_000;
const CHILD_CLOSE_TIMEOUT_MS = 3_000;

/** True if `value` stays within the cmd.exe candidate subset (no " % ! or control chars). */
function pathWithinCandidateSubset(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x00 || cp === 0x0d || cp === 0x0a || ch === '"' || ch === "%" || ch === "!") {
      return false;
    }
  }
  return true;
}

// If the system tmpdir carries a character the candidate rejects, the .cmd
// fixture path itself would be rejected — a bounded-conformance limit of the
// environment, not an encoder regression. Gate the live suite explicitly.
const TMP_SAFE = pathWithinCandidateSubset(tmpdir());
const RUN_LIVE = IS_WINDOWS && TMP_SAFE;

let liveComSpec: string;

function requireLiveComSpec(): string {
  const value = process.env["ComSpec"] ?? process.env["COMSPEC"];
  if (value === undefined || value.length === 0) {
    throw new Error("Windows live spike requires ComSpec");
  }
  expect(win32.isAbsolute(value)).toBe(true);
  expect(win32.basename(value).toLowerCase()).toBe("cmd.exe");
  return value;
}

/**
 * Encode `process.execPath` as a literal inside batch-file source (a distinct
 * context from argument encoding). Narrow fixture rule: reject characters this
 * fixture does not establish safe in a quoted batch literal, so a malformed
 * executable path fails the fixture loudly rather than corrupting the spike.
 */
function batchLiteralExecutable(value: string): string {
  if (value.includes('"') || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("process.execPath cannot be represented by this batch fixture");
  }
  return value.replaceAll("%", "%%");
}

/** Build a Windows PATH env with `additions` first and exactly one `Path` key. */
function withWindowsPath(
  additions: readonly string[],
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  return {
    ...base,
    ...extra,
    Path: [...additions, process.env["Path"] ?? process.env["PATH"] ?? ""].join(";"),
  };
}

/** Write a representative Node-forwarding `.cmd` shim + its arg-dumper into `dir`. */
async function writeForwardingShim(dir: string): Promise<string> {
  await writeFile(
    join(dir, "arg-echo.cjs"),
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "if (process.env.ARG_ECHO_STDOUT) process.stdout.write(process.env.ARG_ECHO_STDOUT);",
      "if (process.env.ARG_ECHO_STDERR) process.stderr.write(process.env.ARG_ECHO_STDERR);",
      "if (process.env.ARG_ECHO_CWD_OUT) fs.writeFileSync(process.env.ARG_ECHO_CWD_OUT, process.cwd());",
      "if (process.env.ARG_ECHO_RESOLVE_OUT) fs.writeFileSync(process.env.ARG_ECHO_RESOLVE_OUT, path.resolve(process.argv[2] || ''));",
      "fs.writeFileSync(process.env.ARG_ECHO_OUT, JSON.stringify(process.argv.slice(2)));",
      "process.exit(Number(process.env.ARG_ECHO_EXIT || '0'));",
      "",
    ].join("\n"),
  );
  const cmdPath = join(dir, "agent.cmd");
  const node = batchLiteralExecutable(process.execPath);
  await writeFile(cmdPath, `@echo off\r\n"${node}" "%~dp0arg-echo.cjs" %*\r\n`);
  return cmdPath;
}

/** Write a `.cmd` forwarding to a companion `.cjs` that writes `label` to OUT (no nested -e). */
async function writeLabelShim(dir: string, label: string): Promise<string> {
  await writeFile(
    join(dir, "label.cjs"),
    `require('fs').writeFileSync(process.env.OUT, ${JSON.stringify(label)});\n`,
  );
  const cmdPath = join(dir, "agent.cmd");
  const node = batchLiteralExecutable(process.execPath);
  await writeFile(cmdPath, `@echo off\r\n"${node}" "%~dp0label.cjs"\r\n`);
  return cmdPath;
}

type CleanupResult =
  | "child-closed"
  | "taskkill-failed"
  | "taskkill-timeout"
  | "child-close-timeout"
  | "unavailable";

type Execution =
  | { readonly kind: "spawn-error"; readonly errorCode: string | undefined }
  | {
      readonly kind: "timeout";
      readonly stdout: string;
      readonly stderr: string;
      readonly cleanup: CleanupResult;
    }
  | {
      readonly kind: "exit";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
    };

/** Bounded harness cleanup: absolute taskkill.exe (finite), then a finite wait for the child's close. */
async function terminateTree(child: ChildProcess): Promise<CleanupResult> {
  const systemRoot = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"];
  if (systemRoot === undefined || child.pid === undefined) return "unavailable";
  const taskkill = win32.join(systemRoot, "System32", "taskkill.exe");

  const taskkillOutcome = await new Promise<"ok" | "failed" | "timeout">((resolve) => {
    const k = spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    const t = setTimeout(() => {
      try {
        k.kill();
      } catch {
        /* ignore */
      }
      resolve("timeout");
    }, TASKKILL_TIMEOUT_MS);
    k.once("error", () => {
      clearTimeout(t);
      resolve("failed");
    });
    k.once("close", (code) => {
      clearTimeout(t);
      resolve(code === 0 ? "ok" : "failed");
    });
  });
  if (taskkillOutcome === "timeout") return "taskkill-timeout";
  if (taskkillOutcome === "failed") return "taskkill-failed";

  const childClosed = await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const t = setTimeout(() => resolve(false), CHILD_CLOSE_TIMEOUT_MS);
    child.once("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  return childClosed ? "child-closed" : "child-close-timeout";
}

/** Test-only executor: spawn a plan, capture stdout/stderr, resolve on close/error/timeout. */
async function execute(
  plan: CommandLaunchPlan,
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<Execution> {
  const child = spawn(plan.command, [...plan.args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: plan.shell,
    ...(plan.kind === "windows-cmd"
      ? { windowsVerbatimArguments: plan.windowsVerbatimArguments }
      : {}),
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  return await new Promise<Execution>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (result: Execution): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      timedOut = true;
      void (async () => {
        const cleanup = await terminateTree(child);
        done({ kind: "timeout", stdout, stderr, cleanup });
      })();
    }, EXECUTION_TIMEOUT_MS);
    child.once("error", (e) =>
      done({ kind: "spawn-error", errorCode: (e as NodeJS.ErrnoException).code }),
    );
    child.once("close", (code, signal) => {
      if (timedOut) return; // let the timeout path resolve
      done({ kind: "exit", exitCode: code, signal, stdout, stderr });
    });
  });
}

/** Build a plan with the validated live ComSpec, or fail the test. */
function livePlan(target: string, args: readonly string[]): CommandLaunchPlan {
  const r = buildCommandLaunchPlan({
    platform: "win32",
    resolvedTarget: target,
    requestedCommand: "agent",
    args,
    resolvedComSpec: liveComSpec,
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.plan;
}

it.runIf(IS_WINDOWS && !TMP_SAFE)(
  "live spike skipped: system tmpdir is outside the cmd.exe candidate subset (bounded conformance)",
  () => {
    console.info(`[H11.1 spike] SKIPPED — tmpdir contains a rejected character`);
  },
);

describe.runIf(RUN_LIVE)("command-launcher — Windows live spike", () => {
  let root: string;
  let dir: string; // path CONTAINS a space
  let shim: string;
  let outFile: string;

  beforeAll(() => {
    liveComSpec = requireLiveComSpec();
    console.info(
      `[H11.1 spike] os=win32 release=${release()} arch=${arch()} node=${process.version} ` +
        `comspec-basename=${win32.basename(liveComSpec)} shim=node-forwarding delayedExpansion=off`,
    );
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vr-launcher-"));
    dir = join(root, "dir with space");
    await mkdir(dir, { recursive: true });
    shim = await writeForwardingShim(dir);
    outFile = join(root, "argv.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function capturedArgv(): Promise<string[]> {
    const parsed: unknown = JSON.parse(await readFile(outFile, "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as unknown[];
    expect(arr.every((x) => typeof x === "string")).toBe(true);
    return arr as string[];
  }

  it(
    "delivers accepted arguments to the child string-for-string",
    async () => {
      const args = [
        "plain",
        "a & b | c < d > e",
        "(f)^g",
        "",
        "/c",
        "/s",
        "/d",
        "/v:on",
        "/?",
        "trail\\",
        "trail\\\\",
        "trail\\\\\\",
        "日本語",
        "😀",
        "e\u0301",
      ];
      const result = await execute(livePlan(shim, args), {
        cwd: root,
        env: { ...process.env, ARG_ECHO_OUT: outFile },
      });
      expect(result.kind).toBe("exit");
      if (result.kind !== "exit") return;
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(await capturedArgv()).toEqual(args);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not execute command-like argument content (no injection, no marker)",
    async () => {
      const marker = "INJECTED.marker";
      const injection = `x & echo INJECTED > ${marker}`; // accepted subset (no " % !)
      const result = await execute(livePlan(shim, [injection]), {
        cwd: root,
        env: { ...process.env, ARG_ECHO_OUT: outFile },
      });
      expect(result.kind).toBe("exit");
      if (result.kind !== "exit") return;
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(await capturedArgv()).toEqual([injection]);
      await expect(readFile(join(root, marker), "utf8")).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "propagates the shim's exit code",
    async () => {
      const result = await execute(livePlan(shim, ["x"]), {
        cwd: root,
        env: { ...process.env, ARG_ECHO_OUT: outFile, ARG_ECHO_EXIT: "7" },
      });
      expect(result).toMatchObject({ kind: "exit", exitCode: 7, signal: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "distinguishes interpreter launch failure (spawn-error) from a child non-zero exit",
    async () => {
      const ok = await execute(livePlan(shim, ["x"]), {
        cwd: root,
        env: { ...process.env, ARG_ECHO_OUT: outFile, ARG_ECHO_EXIT: "7" },
      });
      expect(ok).toMatchObject({ kind: "exit", exitCode: 7 });

      const bogus = buildCommandLaunchPlan({
        platform: "win32",
        resolvedTarget: shim,
        requestedCommand: "agent",
        args: ["x"],
        resolvedComSpec: "C:\\vr-nonexistent\\cmd.exe",
      });
      expect(bogus.ok).toBe(true);
      if (!bogus.ok) return;
      const failed = await execute(bogus.plan, {
        cwd: root,
        env: { ...process.env, ARG_ECHO_OUT: outFile },
      });
      expect(failed.kind).toBe("spawn-error");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "attaches stdout and stderr",
    async () => {
      const result = await execute(livePlan(shim, ["x"]), {
        cwd: root,
        env: {
          ...process.env,
          ARG_ECHO_OUT: outFile,
          ARG_ECHO_STDOUT: "OUT-VALUE",
          ARG_ECHO_STDERR: "ERR-VALUE",
        },
      });
      expect(result.kind).toBe("exit");
      if (result.kind !== "exit") return;
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toContain("OUT-VALUE");
      expect(result.stderr).toContain("ERR-VALUE");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "passes the working directory to the child, resolves %~dp0, and keeps relative args relative",
    async () => {
      const workdir = join(root, "work dir");
      await mkdir(workdir, { recursive: true });
      const cwdOut = join(root, "cwd.txt");
      const resolveOut = join(root, "resolved.txt");
      const result = await execute(livePlan(shim, ["rel.txt"]), {
        cwd: workdir,
        env: {
          ...process.env,
          ARG_ECHO_OUT: outFile,
          ARG_ECHO_CWD_OUT: cwdOut,
          ARG_ECHO_RESOLVE_OUT: resolveOut,
        },
      });
      expect(result.kind).toBe("exit");
      if (result.kind !== "exit") return;
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      // %~dp0 found the companion (the shim ran and forwarded the arg).
      expect(await capturedArgv()).toEqual(["rel.txt"]);
      expect(win32.normalize(await readFile(cwdOut, "utf8"))).toBe(win32.normalize(workdir));
      // The relative arg resolves against the supplied working directory.
      expect(win32.normalize(await readFile(resolveOut, "utf8"))).toBe(
        win32.normalize(join(workdir, "rel.txt")),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects expansion-shaped input before launch and creates no side effect",
    async () => {
      for (const arg of ["%VR_TEST_EXPANSION%", "!VR_TEST_EXPANSION!"]) {
        const r = buildCommandLaunchPlan({
          platform: "win32",
          resolvedTarget: shim,
          requestedCommand: "agent",
          args: [arg],
          resolvedComSpec: liveComSpec,
        });
        expect(r).toMatchObject({ ok: false, error: "unsafe-windows-cmd-argument" });
      }
      // Nothing was executed → no argv output file exists.
      await expect(readFile(outFile, "utf8")).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs the exact resolved target, not a same-named shim earlier on PATH",
    async () => {
      const dirA = join(root, "A dir");
      const dirB = join(root, "B dir");
      await mkdir(dirA, { recursive: true });
      await mkdir(dirB, { recursive: true });
      const cmdA = await writeLabelShim(dirA, "A");
      await writeLabelShim(dirB, "B");

      // Precondition: bare "agent" resolution over this PATH would select B.
      const resolver = createExecutablePathResolver({
        platform: "win32",
        env: withWindowsPath([dirB, dirA]),
        fileIsExecutable: (p) => {
          try {
            return statSync(p).isFile();
          } catch {
            return false;
          }
        },
      });
      const resolved = resolver("agent");
      expect(resolved?.toLowerCase()).toBe(join(dirB, "agent.cmd").toLowerCase());

      // But the plan is built from A's ABSOLUTE path → A must run.
      const result = await execute(livePlan(cmdA, []), {
        cwd: root,
        env: withWindowsPath([dirB, dirA], { OUT: outFile }),
      });
      expect(result.kind).toBe("exit");
      if (result.kind !== "exit") return;
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(existsSync(outFile)).toBe(true);
      expect(await readFile(outFile, "utf8")).toBe("A");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "preserves native direct spawning (a native .exe is not routed through cmd.exe)",
    async () => {
      const plan = livePlan(process.execPath, [join(dir, "arg-echo.cjs"), "one", "two"]);
      expect(plan.kind).toBe("direct");
      expect(plan.strategy).toBe("direct-v1");
      const result = await execute(plan, {
        cwd: root,
        env: { ...process.env, ARG_ECHO_OUT: outFile },
      });
      expect(result.kind).toBe("exit");
      if (result.kind !== "exit") return;
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(await capturedArgv()).toEqual(["one", "two"]);
    },
    TEST_TIMEOUT_MS,
  );
});
