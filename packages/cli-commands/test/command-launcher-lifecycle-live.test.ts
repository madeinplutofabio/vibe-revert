// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Windows lifecycle spike for the command launch-plan builder (M H11.1, ADR 0005
// Decision 7). Characterizes the two AUTOMATABLE lifecycle results only —
// forced_recovery and orphan_posture. Interactive Ctrl+C delivery and wrapper
// completion are manual (docs/security/windows-cmd-mediation-lifecycle.md).
//
// Evidence model: every fixture writes a readiness record {role,pid,token,ts} and
// an atomically-rewritten heartbeat {pid,token,seq,ts}. Processes are identified
// by the PID recorded at readiness, bound to a per-run token — never by image
// name. A heartbeat is trusted only when its token AND its pid match that role's
// readiness record. Cleanup kills tracked ChildProcess handles by their live .pid
// and, for descendants, only readiness-bound PIDs whose heartbeat is still
// token-and-pid-matched and advancing (PID-reuse-safe).

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, release, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildCommandLaunchPlan } from "../src/commands/command-launcher.js";

const IS_WINDOWS = process.platform === "win32";
const HEARTBEAT_MS = 100;
const READINESS_TIMEOUT_MS = 8_000;
const OBSERVATION_MS = 900; // > 2 heartbeat intervals
const SETTLE_AFTER_KILL_MS = 400;
const WRAPPER_CLOSE_TIMEOUT_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 4_000;
const TEST_TIMEOUT_MS = 40_000;

function pathWithinCandidateSubset(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x00 || cp === 0x0d || cp === 0x0a || ch === '"' || ch === "%" || ch === "!")
      return false;
  }
  return true;
}
const TMP_SAFE = pathWithinCandidateSubset(tmpdir());
const RUN_LIVE = IS_WINDOWS && TMP_SAFE;

let liveComSpec: string;

function requireLiveComSpec(): string {
  const value = process.env["ComSpec"] ?? process.env["COMSPEC"];
  if (value === undefined || value.length === 0)
    throw new Error("lifecycle spike requires ComSpec");
  expect(win32.isAbsolute(value)).toBe(true);
  expect(win32.basename(value).toLowerCase()).toBe("cmd.exe");
  return value;
}

function batchLiteralExecutable(value: string): string {
  if (value.includes('"') || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("process.execPath cannot be represented by this batch fixture");
  }
  return value.replaceAll("%", "%%");
}

/** Node source for a heartbeat fixture; optionally spawns a child fixture first. */
function fixtureSource(role: string, spawnChildFile?: string): string {
  return [
    "const fs=require('fs');const path=require('path');",
    spawnChildFile
      ? `require('child_process').spawn(process.execPath,[path.join(__dirname,${JSON.stringify(spawnChildFile)})],{env:process.env,stdio:'ignore'});`
      : "",
    "const token=process.env.RUN_TOKEN;",
    `const ready=path.join(__dirname,${JSON.stringify(`${role}.ready.json`)});`,
    `const hb=path.join(__dirname,${JSON.stringify(`${role}.hb.json`)});`,
    `fs.writeFileSync(ready,JSON.stringify({role:${JSON.stringify(role)},pid:process.pid,token,ts:Date.now()}));`,
    "let seq=0;",
    "function beat(){",
    "  const tmp=hb+'.tmp';",
    "  try{",
    "    fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,token,seq,ts:Date.now()}));",
    "    fs.renameSync(tmp,hb);",
    "    seq+=1;",
    "  }catch(error){",
    "    const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;",
    "    if(code!=='EPERM'&&code!=='EACCES'&&code!=='EBUSY'){throw error;}",
    "    try{fs.rmSync(tmp,{force:true});}catch{}",
    "  }",
    "}",
    `beat();setInterval(beat,${HEARTBEAT_MS});`,
    "",
  ].join("\n");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readSeq(file: string): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const j = await readJson(file);
    if (j !== null && typeof j["seq"] === "number") return j["seq"];
    await sleep(20);
  }
  return -1;
}

async function observeAdvancing(file: string): Promise<boolean> {
  const initial = await readSeq(file);
  if (initial < 0) return false;
  const deadline = Date.now() + OBSERVATION_MS;
  while (Date.now() < deadline) {
    await sleep(60);
    if ((await readSeq(file)) > initial) return true;
  }
  return false;
}

async function observeFrozen(file: string): Promise<boolean> {
  const initial = await readSeq(file);
  if (initial < 0) return false;
  const deadline = Date.now() + OBSERVATION_MS;
  while (Date.now() < deadline) {
    await sleep(60);
    const current = await readSeq(file);
    if (current < 0 || current > initial) return false;
  }
  return true;
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${file}`);
}

type TaskkillResult =
  | { status: "ok"; exitCode: 0 }
  | { status: "nonzero"; exitCode: number; stderr: string }
  | { status: "spawn_error"; message: string }
  | { status: "timeout" }
  | { status: "unavailable" };

const TASKKILL_STDERR_CAP = 2048;

/** Normalize CR/LF and bound length so a pathological process cannot flood output. */
function boundStderr(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n");
  return normalized.length > TASKKILL_STDERR_CAP
    ? normalized.slice(0, TASKKILL_STDERR_CAP)
    : normalized;
}

/**
 * Absolute taskkill.exe; `tree` adds `/t`. Bounded and single-settle, with
 * bounded stderr capture.
 *
 * A non-zero process exit is kept distinct from spawn failure, timeout, and
 * unavailability. The full-suite H11.1 observation produced a non-zero exit
 * while the observable recovery contract still succeeded; the reason is not
 * inferred here and is left to the captured diagnostics.
 */
async function taskkill(pid: number, tree: boolean): Promise<TaskkillResult> {
  const systemRoot = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"];
  if (systemRoot === undefined) return { status: "unavailable" };
  const exe = win32.join(systemRoot, "System32", "taskkill.exe");
  const args = ["/pid", String(pid), ...(tree ? ["/t"] : []), "/f"];
  return await new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stderrBuf = "";
    const done = (result: TaskkillResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    const k = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
    k.stderr?.on("data", (chunk: Buffer | string) => {
      const remaining = TASKKILL_STDERR_CAP - stderrBuf.length;
      if (remaining <= 0) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrBuf += text.slice(0, remaining);
    });
    timer = setTimeout(() => {
      try {
        k.kill();
      } catch {
        /* ignore */
      }
      done({ status: "timeout" });
    }, TASKKILL_TIMEOUT_MS);
    k.once("error", (err) => done({ status: "spawn_error", message: err.message }));
    k.once("close", (code) => {
      done(
        code === 0
          ? { status: "ok", exitCode: 0 }
          : { status: "nonzero", exitCode: code ?? -1, stderr: boundStderr(stderrBuf) },
      );
    });
  });
}

/** Format taskkill diagnostics for the single-line lifecycle log. */
function taskkillDiag(result: TaskkillResult): string {
  const exitCode =
    result.status === "ok" ? "0" : result.status === "nonzero" ? String(result.exitCode) : "none";
  const diagnostic =
    result.status === "nonzero"
      ? result.stderr
      : result.status === "spawn_error"
        ? boundStderr(result.message)
        : "";
  return (
    `taskkill_status=${result.status} ` +
    `taskkill_exit_code=${exitCode} ` +
    `taskkill_stderr=${JSON.stringify(diagnostic)}`
  );
}

describe.runIf(RUN_LIVE)("command-launcher — Windows lifecycle spike", () => {
  let root: string;
  let dir: string; // path contains a space
  let token: string;
  let spawnedChildren: ChildProcess[] = [];
  const readinessPids = new Map<string, number>();

  const p = (name: string): string => join(dir, name);

  function spawnWrapper(): ChildProcess {
    const r = buildCommandLaunchPlan({
      platform: "win32",
      resolvedTarget: p("agent.cmd"),
      requestedCommand: "agent",
      args: [],
      resolvedComSpec: liveComSpec,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    if (r.plan.kind !== "windows-cmd") throw new Error("expected windows-cmd plan");
    const child = spawn(r.plan.command, [...r.plan.args], {
      env: { ...process.env, RUN_TOKEN: token },
      stdio: "ignore",
      shell: false,
      windowsVerbatimArguments: r.plan.windowsVerbatimArguments,
    });
    spawnedChildren.push(child);
    return child;
  }

  function spawnSentinel(): ChildProcess {
    const child = spawn(process.execPath, [p("sentinel.cjs")], {
      env: { ...process.env, RUN_TOKEN: token },
      stdio: "ignore",
    });
    spawnedChildren.push(child);
    return child;
  }

  async function readReadiness(role: string): Promise<number> {
    const j = await readJson(p(`${role}.ready.json`));
    expect(j).not.toBeNull();
    expect(j?.["role"]).toBe(role);
    expect(j?.["token"]).toBe(token);
    expect(typeof j?.["pid"]).toBe("number");
    expect(typeof j?.["ts"]).toBe("number");
    const pid = j?.["pid"] as number;
    readinessPids.set(role, pid);
    return pid;
  }

  /** A heartbeat is trusted only when its token AND pid match the role's readiness record. */
  async function heartbeatIdentityOk(role: string): Promise<boolean> {
    const expectedPid = readinessPids.get(role);
    const heartbeat = await readJson(p(`${role}.hb.json`));
    return (
      expectedPid !== undefined &&
      heartbeat?.["token"] === token &&
      heartbeat["pid"] === expectedPid &&
      typeof heartbeat["seq"] === "number" &&
      typeof heartbeat["ts"] === "number"
    );
  }

  async function awaitClose(child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + WRAPPER_CLOSE_TIMEOUT_MS;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
      await sleep(50);
    return child.exitCode !== null || child.signalCode !== null;
  }

  beforeAll(() => {
    liveComSpec = requireLiveComSpec();
    console.info(
      `[H11.1 lifecycle] os=win32 release=${release()} arch=${arch()} node=${process.version} ` +
        `comspec-basename=${win32.basename(liveComSpec)}`,
    );
  });

  beforeEach(async () => {
    spawnedChildren = [];
    readinessPids.clear();
    token = `tok-${randomUUID()}`;
    root = await mkdtemp(join(tmpdir(), "vr-lifecycle-"));
    dir = join(root, "dir with space");
    await mkdir(dir, { recursive: true });
    await writeFile(p("grandchild.cjs"), fixtureSource("grandchild"));
    await writeFile(p("parent.cjs"), fixtureSource("parent", "grandchild.cjs"));
    await writeFile(p("sentinel.cjs"), fixtureSource("sentinel"));
    await writeFile(
      p("agent.cmd"),
      `@echo off\r\n"${batchLiteralExecutable(process.execPath)}" "%~dp0parent.cjs"\r\n`,
    );
  });

  afterEach(async () => {
    // 1. Kill tracked handles still running, by their live .pid (tree).
    for (const child of spawnedChildren) {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        await taskkill(child.pid, true);
      }
    }
    // 2. Token- AND pid-verified individual cleanup of surviving descendants
    //    (orphan case): only readiness-bound PIDs whose heartbeat still matches
    //    and is advancing — never a PID found only in a mutable heartbeat file.
    for (const role of ["parent", "grandchild"] as const) {
      const expectedPid = readinessPids.get(role);
      const heartbeat = await readJson(p(`${role}.hb.json`));
      if (
        expectedPid !== undefined &&
        heartbeat?.["token"] === token &&
        heartbeat["pid"] === expectedPid &&
        (await observeAdvancing(p(`${role}.hb.json`)))
      ) {
        await taskkill(expectedPid, true);
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it(
    "forced PID-tree cleanup stops the mediated tree while an unrelated sentinel survives",
    async () => {
      spawnSentinel();
      const wrapper = spawnWrapper();
      const wrapperPid = wrapper.pid;
      expect(typeof wrapperPid).toBe("number");
      if (typeof wrapperPid !== "number") return;

      await waitForFile(p("parent.ready.json"), READINESS_TIMEOUT_MS);
      await waitForFile(p("grandchild.ready.json"), READINESS_TIMEOUT_MS);
      await waitForFile(p("sentinel.ready.json"), READINESS_TIMEOUT_MS);
      await readReadiness("parent");
      await readReadiness("grandchild");
      await readReadiness("sentinel");

      expect(await heartbeatIdentityOk("parent")).toBe(true);
      expect(await heartbeatIdentityOk("grandchild")).toBe(true);
      expect(await heartbeatIdentityOk("sentinel")).toBe(true);
      expect(await observeAdvancing(p("parent.hb.json"))).toBe(true);
      expect(await observeAdvancing(p("grandchild.hb.json"))).toBe(true);
      expect(await observeAdvancing(p("sentinel.hb.json"))).toBe(true);

      const taskkillResult = await taskkill(wrapperPid, true);
      const wrapper_close_observed = await awaitClose(wrapper);
      await sleep(SETTLE_AFTER_KILL_MS);

      const parent_frozen = await observeFrozen(p("parent.hb.json"));
      const grandchild_frozen = await observeFrozen(p("grandchild.hb.json"));
      const sentinel_advanced = await observeAdvancing(p("sentinel.hb.json"));

      const forced_recovery = !sentinel_advanced
        ? "sentinel_affected"
        : !parent_frozen || !grandchild_frozen
          ? "tree_not_fully_stopped"
          : "tree_stopped_sentinel_survived";
      console.info(
        `[H11.1 lifecycle] forced_recovery=${forced_recovery} ${taskkillDiag(taskkillResult)} ` +
          `wrapper_close_observed=${wrapper_close_observed} parent_frozen=${parent_frozen} ` +
          `grandchild_frozen=${grandchild_frozen} sentinel_advanced=${sentinel_advanced}`,
      );

      // The authoritative recovery signal is the observed process state
      // (descendants frozen, sentinel advancing); taskkill's non-zero exit is
      // recorded, not required. Only a launch / timeout / unavailable taskkill is
      // a real failure.
      expect(taskkillResult.status).not.toBe("unavailable");
      expect(taskkillResult.status).not.toBe("spawn_error");
      expect(taskkillResult.status).not.toBe("timeout");
      expect(wrapper_close_observed).toBe(true);
      expect(forced_recovery).toBe("tree_stopped_sentinel_survived");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "characterizes descendant survival after wrapper-only termination",
    async () => {
      spawnSentinel();
      const wrapper = spawnWrapper();
      const wrapperPid = wrapper.pid;
      expect(typeof wrapperPid).toBe("number");
      if (typeof wrapperPid !== "number") return;

      await waitForFile(p("parent.ready.json"), READINESS_TIMEOUT_MS);
      await waitForFile(p("grandchild.ready.json"), READINESS_TIMEOUT_MS);
      await waitForFile(p("sentinel.ready.json"), READINESS_TIMEOUT_MS);
      await readReadiness("parent");
      await readReadiness("grandchild");
      await readReadiness("sentinel");

      // Before-state: all three fixtures are identity-verified and advancing.
      expect(await heartbeatIdentityOk("parent")).toBe(true);
      expect(await heartbeatIdentityOk("grandchild")).toBe(true);
      expect(await heartbeatIdentityOk("sentinel")).toBe(true);
      expect(await observeAdvancing(p("parent.hb.json"))).toBe(true);
      expect(await observeAdvancing(p("grandchild.hb.json"))).toBe(true);
      expect(await observeAdvancing(p("sentinel.hb.json"))).toBe(true);

      const wrapper_taskkill = await taskkill(wrapperPid, false); // wrapper only, no /t
      const wrapper_close_observed = await awaitClose(wrapper);
      // Interpret descendant survival only after a terminal wrapper-only kill
      // result (not unavailable / spawn_error / timeout) and observed wrapper
      // closure; taskkill's non-zero exit is recorded, not required.
      expect(wrapper_taskkill.status).not.toBe("unavailable");
      expect(wrapper_taskkill.status).not.toBe("spawn_error");
      expect(wrapper_taskkill.status).not.toBe("timeout");
      expect(wrapper_close_observed).toBe(true);
      await sleep(SETTLE_AFTER_KILL_MS);

      const parentAdv = await observeAdvancing(p("parent.hb.json"));
      const grandchildAdv = await observeAdvancing(p("grandchild.hb.json"));
      const sentinel_advanced = await observeAdvancing(p("sentinel.hb.json"));
      const parentIdentityOk = await heartbeatIdentityOk("parent");
      const grandchildIdentityOk = await heartbeatIdentityOk("grandchild");
      const sentinelIdentityOk = await heartbeatIdentityOk("sentinel");

      const orphan_posture =
        parentAdv && grandchildAdv
          ? "descendants_survived_observation_window"
          : !parentAdv && !grandchildAdv
            ? "descendants_terminated_with_wrapper"
            : "mixed_descendant_state";

      console.info(
        `[H11.1 lifecycle] orphan_posture=${orphan_posture} ${taskkillDiag(wrapper_taskkill)} ` +
          `wrapper_close_observed=${wrapper_close_observed} sentinel_advanced=${sentinel_advanced}`,
      );

      // Observable posture, scoped to the bounded observation window (not a universal
      // Windows guarantee): the token-bound descendants kept advancing and the sentinel
      // was unaffected after a confirmed wrapper-only termination.
      expect(parentIdentityOk && grandchildIdentityOk && sentinelIdentityOk).toBe(true);
      expect(sentinel_advanced).toBe(true);
      expect(orphan_posture).toBe("descendants_survived_observation_window");
    },
    TEST_TIMEOUT_MS,
  );
});
