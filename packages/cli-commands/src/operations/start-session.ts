// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// Typed operation backing `viberevert start` (CLI) and `start_session`
// (MCP). Owns all domain logic: repo-root resolution, config load, D22
// start-lock, D11 active-session pre-check, inner-checkpoint creation,
// git porcelain capture, core.startSession hand-off, D13 cleanup.
//
// Owns NO presentation: never writes to process.stdout / process.stderr,
// never calls console.*, never reads process.cwd() (uses opts.cwd).
//
// =============================================================================
// Architectural locks (carried over from StartCommand verbatim)
// =============================================================================
//
// 1. **D19** — REQUIRES valid config. Hard-fails with typed errors on
//    missing or invalid `.viberevert.yml`. Callers (CLI Command, MCP
//    handler) translate to presentation.
//
// 2. **D16/D17c** — git invocation through `@viberevert/git` only. NO
//    `child_process` imports here.
//
// 3. **D22** — start-lock around all session-state I/O. The
//    `.viberevert/.locks/start.lock/` mkdir-based exclusive lock is
//    acquired BEFORE `loadActiveSessionLock` and held through the final
//    `active-session.json` write.
//
// 4. **D17b** — locked orchestration order: pre-check active lock →
//    generate sessionId → create tmp dir → write inner checkpoint INSIDE
//    tmp dir → fetch git status AFTER checkpoint → call
//    core.startSession (which atomically renames tmp dir + writes
//    active-session.json).
//
// 5. **Deterministic timestamps** — `resolveNowForCliTimestamp()` runs
//    ONCE per operation invocation. The same value threads into THREE
//    slots: persisted `session.started_at`, inner-checkpoint
//    `manifest.captured_at`, and D22 lock metadata.
//
// 6. **D13/D17c cleanup on failure** — best-effort `rm -rf` of the tmp
//    session dir if anything between mkdir(tmp) and core.startSession's
//    rename throws. Cleanup errors are silently swallowed (the original
//    error still propagates).
//
// =============================================================================
// Callers must catch these typed errors and map to presentation
// =============================================================================
//
// - RepoRootNotFoundError    (from @viberevert/core)         → "No git repo or VibeRevert project found"
// - ConfigNotFoundError      (from @viberevert/core)         → "No .viberevert.yml found in this repo"
// - ConfigParseError         (from @viberevert/core)         → "Invalid .viberevert.yml: <msg>"
// - ConfigValidationError    (from @viberevert/core)         → "Invalid .viberevert.yml: <msg>"
// - RuntimeEnvInvalidError   (from runtime-env.js)           → test-only env-override malformed
// - SessionAlreadyActiveError (from @viberevert/core)        → D11 refusal copy (active.session_id etc.)
// - ConcurrentOperationError (from locks.js)                 → D22 refusal copy (info.command etc.)
//
// =============================================================================
// Input validation boundary
// =============================================================================
//
// This operation accepts `opts.task` as-is. CLI flag-parse and MCP Zod
// `inputSchema` MUST reject empty/whitespace-only task BEFORE calling.
// The operation remains defensive-light to avoid double-validation
// drift between the two callers.

import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  generateSessionId,
  loadActiveSessionLock,
  loadConfig,
  resolveRepoRoot,
  SessionAlreadyActiveError,
  startSession,
} from "@viberevert/core";
import { createCheckpoint, getStatusPorcelainText } from "@viberevert/git";

import { type LockInfo, withExclusiveLock } from "../locks.js";
import { resolveNowForCliTimestamp } from "../runtime-env.js";

export const START_LOCK_REL = ".viberevert/.locks/start.lock";

export type StartSessionOperationOpts = {
  /** Directory to resolve the repo root from. Caller-supplied; the
   *  operation MUST NOT read `process.cwd()`. */
  cwd: string;
  /** Optional human-readable task description. Caller MUST pre-validate
   *  (non-empty, non-whitespace) — operation does not re-validate. */
  task?: string;
  /** Optional D22 lock-metadata label identifying who holds the lock.
   *  Defaults to the existing CLI literal (`"viberevert start"` or
   *  `"viberevert start --task <json>"`) so CLI behavior is unchanged
   *  when the field is omitted. MCP handlers should pass something like
   *  `"viberevert mcp start_session"` so D22 concurrent-operation refusal
   *  copy is truthful about the actual holder without leaking raw MCP
   *  argument bytes into lock metadata. */
  lockCommand?: string;
};

export type StartSessionOperationResult = {
  sessionId: string; // sess_<ULID>
  checkpointId: string; // cp_<ULID>
  startedAt: string; // ISO-8601 UTC (second precision)
};

export async function startSessionOperation(
  opts: StartSessionOperationOpts,
): Promise<StartSessionOperationResult> {
  // Step 1: resolve repo root from caller-supplied cwd.
  const repoRoot = resolveRepoRoot(opts.cwd);

  // Step 2: load+validate config (D19; outside the D22 lock per the
  // "config touches .viberevert.yml, not session state" scope).
  const config = await loadConfig(repoRoot);
  const rollbackExcludePatterns: readonly string[] = config.rollback?.exclude ?? [];

  // Step 3: resolve the wall-clock timestamp ONCE for this operation.
  // Threaded into THREE slots — see header lock #5: persisted
  // session.started_at, inner-checkpoint manifest.captured_at, and D22
  // lock metadata.
  const now = resolveNowForCliTimestamp();

  // Step 4: enter the D22 start-lock. All session-state I/O happens
  // inside `protectedFlow` so the lock covers loadActiveSessionLock →
  // createCheckpoint → startSession → active-lock write atomically with
  // respect to other concurrent operations.
  const protectedFlow = async (): Promise<StartSessionOperationResult> => {
    // Step 4a: pre-check the active lock BEFORE doing any expensive
    // work. Without this, an already-active session would still trigger
    // checkpoint creation, getStatusPorcelainText, etc. core.startSession
    // re-checks the lock internally (defensive against the narrow race
    // between our check and core's check).
    const existing = await loadActiveSessionLock(repoRoot);
    if (existing !== null) {
      throw new SessionAlreadyActiveError(existing);
    }

    // Step 4b: generate session id (core owns session identity per D5/D16).
    const sessionId = generateSessionId();

    // Step 4c: ensure parent dir exists (idempotent).
    const sessionsDirAbs = join(repoRoot, ".viberevert", "sessions");
    await mkdir(sessionsDirAbs, { recursive: true });

    // Step 4d: create the tmp session dir. Id-bearing per D13.
    const tmpSessionDir = join(sessionsDirAbs, `.tmp-${sessionId}`);
    await mkdir(tmpSessionDir);

    // startedAt is just an alias for `now` (single timestamp policy per
    // header lock #5). Hoisted above the try because it has no failure
    // mode — definite-assignment is trivial.
    const startedAt = now;

    let checkpointId: string;
    try {
      // Step 4e: create the inner-session checkpoint.
      const checkpointResult = await createCheckpoint({
        repoRoot,
        checkpointDir: join(tmpSessionDir, "checkpoint"),
        rollbackExcludePatterns,
        sessionId,
        capturedAt: now,
      });
      checkpointId = checkpointResult.checkpointId;

      // Step 4f: fetch the pre-session git porcelain text.
      const beforeStatusText = await getStatusPorcelainText(repoRoot);

      // Step 4g: hand off to core.startSession. Throws
      // SessionAlreadyActiveError if active-session.json appeared during
      // the narrow race between step 4a and here.
      await startSession({
        repoRoot,
        tmpSessionDir,
        sessionId,
        checkpointId,
        startedAt,
        beforeStatusText,
        ...(opts.task !== undefined ? { task: opts.task } : {}),
      });
    } catch (err) {
      // Best-effort cleanup of tmpSessionDir. If the failure happened
      // BEFORE core.startSession's rename, this removes the partial state.
      // If AFTER the rename, this is a no-op (the dir is at the final
      // path; surfaces as a crash_interrupted warning per D13). Cleanup
      // failures are silently swallowed — the original error propagates.
      await rm(tmpSessionDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    return { sessionId, checkpointId, startedAt };
  };

  const lockDir = join(repoRoot, START_LOCK_REL);
  // Compose the D22 lock metadata `command` label. Defaults to the
  // existing CLI literal so callers that omit `lockCommand` get
  // byte-identical lock metadata to the pre-extraction StartCommand.
  // MCP handlers pass `lockCommand: "viberevert mcp start_session"` to
  // keep D22 concurrent-operation refusal copy truthful.
  const command =
    opts.lockCommand ??
    (opts.task !== undefined
      ? `viberevert start --task ${JSON.stringify(opts.task)}`
      : "viberevert start");
  const lockInfo: LockInfo = {
    pid: process.pid,
    command,
    started_at: now,
    host: hostname(),
  };

  return withExclusiveLock(lockDir, lockInfo, protectedFlow);
}
