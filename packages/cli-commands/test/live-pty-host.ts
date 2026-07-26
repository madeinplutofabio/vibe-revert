// SPDX-FileCopyrightText: 2026 Fabio Marcello Salvadori
// SPDX-License-Identifier: Apache-2.0

// Test-only capability detection for the live-PTY interception suites (M H7).
//
// The live-PTY suites (pty-interception-compound-live, pty-interception-hook-live)
// can only run where the host can actually ALLOCATE a PTY. node-pty loading is
// NOT sufficient: a macOS CI runner loads node-pty and resolves Bash, yet
// `pty.spawn` throws `posix_spawnp failed` at allocation time. This helper
// mirrors the strong prerequisite check the shell-pty-live-smoke release gate
// already uses -- it attempts a trivial `bash -lc "exit 0"` PTY and requires a
// clean exit -- so a spawn-incapable host is a definitive capability SKIP (with
// the OBSERVED reason). The gate is capability-based, not OS-based: a macOS host
// with a working PTY runs the suites; a POSIX host that cannot allocate one skips.
//
// Every unavailable result carries a STABLE reasonCode (M H7 Step 2.4), so the
// accounting policy decides run / permitted-skip / violation from the code, not
// from prose. The reason string remains for CI evidence. The mapping is narrow:
//   - win32                         -> requires_posix_bash
//   - node-pty fails to load        -> node_pty_unavailable
//   - host shell is not Bash        -> bash_unavailable
//   - SYNCHRONOUS pty.spawn failure -> pty_allocation_unavailable
// A probe that ALLOCATES but then exits non-zero, or that hangs, is NOT a
// capability verdict: it THROWS an infrastructure error (the suite goes red)
// rather than masking a broken Bash / environment / node-pty runtime behind a
// benign skip. Because those paths throw, every RETURNED result is definitive and
// is memoized; a throw is naturally uncached, so a one-off hung or misbehaving
// probe never becomes a permanent verdict -- the next caller re-probes. Calls
// within one loaded helper-module instance share a single probe (Vitest may
// isolate test files into separate module contexts).
//
// Capability DETECTION only: each consuming suite routes its host result through
// the accounted helper (live-pty-accounting), which emits a labelled skip and
// calls ctx.skip() only for a permitted disposition / reason-code pair, and
// throws on a contract violation.

import { tmpdir } from "node:os";

import type { LivePtyReasonCode } from "../../../scripts/support-manifest-live-pty.js";
import { loadPtyModule, type PtyModule, type PtyProcess } from "../src/commands/pty-loader.js";
import { resolveHostInteractiveShell } from "../src/commands/shell-pty.js";

export type LivePtyHostResult =
  | { readonly ok: true; readonly pty: PtyModule; readonly bashPath: string }
  | { readonly ok: false; readonly reasonCode: LivePtyReasonCode; readonly reason: string };

// A capable host exits the trivial probe in milliseconds. The run deadline only
// bounds a probe that allocated but never exits; if it fires we kill and then
// wait the (short) cleanup deadline to CONFIRM the PTY closed.
const PROBE_RUN_DEADLINE_MS = 10_000;
const PROBE_CLEANUP_DEADLINE_MS = 2_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The failure branch is explicitly the allocation-only outcome: only a
// synchronous pty.spawn failure produces it (a non-zero exit / timeout THROWS),
// so the stable code is set at the probe, never inferred later from `!ok`.
type ProbeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reasonCode: "pty_allocation_unavailable";
      readonly reason: string;
    };

/**
 * Wait for the probe process across TWO bounded deadlines with a SINGLE exit
 * listener (never disposed-and-reinstalled). A clean exit(0) before any kill is
 * the only success; a non-zero exit THROWS (an allocated PTY that could not run
 * `exit 0` is an infrastructure failure, not a capability skip). If the run
 * deadline expires we kill the probe and, keeping the same listener, wait the
 * cleanup deadline; either timeout path THROWS, so the caller goes red rather
 * than skipping an indeterminate / possibly-leaked PTY.
 */
function awaitProbeOutcome(probe: PtyProcess): Promise<ProbeResult> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    let settled = false;
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sub: { dispose(): void } | undefined;
    let pendingExit: { readonly exitCode: number } | undefined;

    const finish = (): void => {
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      sub?.dispose();
    };
    const succeed = (outcome: ProbeResult): void => {
      if (settled) {
        return;
      }
      finish();
      resolveOutcome(outcome);
    };
    const fail = (err: Error): void => {
      if (settled) {
        return;
      }
      finish();
      rejectOutcome(err);
    };

    const handleExit = (exitCode: number): void => {
      if (settled) {
        return;
      }
      if (killed) {
        // Exit observed only after we asked it to terminate: confirmed closed,
        // but it hung past the run deadline -- an infrastructure failure.
        fail(
          new Error(
            `PTY probe did not exit within ${PROBE_RUN_DEADLINE_MS}ms; killed and confirmed closed`,
          ),
        );
        return;
      }
      if (exitCode === 0) {
        succeed({ ok: true });
        return;
      }
      // Allocated, but the trivial `exit 0` did not exit cleanly: a broken Bash /
      // environment / node-pty runtime, NOT a capability skip.
      fail(
        new Error(
          `PTY probe exited ${exitCode} (expected 0); treating as an infrastructure failure`,
        ),
      );
    };

    sub = probe.onExit((event) => {
      // A synchronous callback (fired during onExit() registration, before `sub`
      // is assigned) is stashed and drained below, so it can neither be missed
      // nor leak the subscription.
      if (sub === undefined) {
        pendingExit = { exitCode: event.exitCode };
        return;
      }
      handleExit(event.exitCode);
    });

    if (pendingExit !== undefined) {
      handleExit(pendingExit.exitCode);
    }
    if (settled) {
      return;
    }

    // Stage 1: run deadline. On expiry, kill and hand off to the cleanup
    // deadline WITHOUT touching the (still-active) exit listener.
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      killed = true;
      try {
        probe.kill();
      } catch {
        // kill() itself failed; the cleanup deadline below still bounds the
        // wait and reports unconfirmed termination if no exit event arrives.
      }
      if (settled) {
        return;
      }
      // Stage 2: cleanup deadline -- same listener stays attached.
      timer = setTimeout(() => {
        fail(
          new Error(
            `PTY probe termination could not be confirmed within ${PROBE_CLEANUP_DEADLINE_MS}ms after kill (possible leaked PTY)`,
          ),
        );
      }, PROBE_CLEANUP_DEADLINE_MS);
      timer.unref?.();
    }, PROBE_RUN_DEADLINE_MS);
    timer.unref?.();
  });
}

/** Allocate a trivial PTY (bash -lc "exit 0") and prove a clean exit. */
async function probePtyAllocation(pty: PtyModule, bashPath: string): Promise<ProbeResult> {
  let probe: PtyProcess;
  try {
    probe = pty.spawn(bashPath, ["-lc", "exit 0"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: { ...process.env, SHELL: bashPath },
    });
  } catch (err) {
    // Synchronous allocation failure (e.g. posix_spawnp) -- no child was
    // created. Definitive: this host cannot allocate a PTY.
    return {
      ok: false,
      reasonCode: "pty_allocation_unavailable",
      reason: `PTY allocation failed at spawn: ${messageOf(err)}`,
    };
  }
  return awaitProbeOutcome(probe);
}

async function resolveLivePtyHostUncached(): Promise<LivePtyHostResult> {
  if (process.platform === "win32") {
    return {
      ok: false,
      reasonCode: "requires_posix_bash",
      reason: "platform is win32 (live Bash PTY tests require a POSIX Bash host)",
    };
  }
  const pty = await loadPtyModule();
  if (pty === null) {
    return {
      ok: false,
      reasonCode: "node_pty_unavailable",
      reason: "node-pty unavailable / failed to load (loadPtyModule() -> null)",
    };
  }
  const shell = resolveHostInteractiveShell();
  if (shell === null || shell.kind !== "bash") {
    return {
      ok: false,
      reasonCode: "bash_unavailable",
      reason: `host interactive shell is not Bash (resolved: ${shell === null ? "none" : shell.kind})`,
    };
  }
  const probe = await probePtyAllocation(pty, shell.path);
  if (!probe.ok) {
    return probe;
  }
  return { ok: true, pty, bashPath: shell.path };
}

let cachedResult: LivePtyHostResult | undefined;
let inFlight: Promise<LivePtyHostResult> | undefined;

/**
 * Resolve this host's live-PTY capability once and memoize the DEFINITIVE result
 * (success, or a capability skip: win32, node-pty unavailable, non-Bash shell,
 * synchronous spawn failure). An infrastructure failure (probe timeout, non-zero
 * probe exit, or unconfirmed termination) THROWS and is left uncached via the
 * finally, so a one-off hung or misbehaving probe cannot become a permanent
 * verdict -- the next caller re-probes. Concurrent callers coalesce onto the
 * in-flight probe.
 */
export async function resolveLivePtyHost(): Promise<LivePtyHostResult> {
  if (cachedResult !== undefined) {
    return cachedResult;
  }
  if (inFlight !== undefined) {
    return inFlight;
  }
  const current = resolveLivePtyHostUncached();
  inFlight = current;
  try {
    const result = await current;
    cachedResult = result;
    return result;
  } finally {
    if (inFlight === current) {
      inFlight = undefined;
    }
  }
}
