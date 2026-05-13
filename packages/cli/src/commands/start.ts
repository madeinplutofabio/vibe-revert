// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// `viberevert start [--task "..."]` — begin a new session, capturing
// the pre-session checkpoint and persisting the active-session lock.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
// 1. **D19: REQUIRES valid config.** Same as `viberevert checkpoint`:
//    `rollback.exclude` directly determines what is captured (D3
//    symmetry), so silently defaulting to `[]` on missing/invalid
//    config would diverge later restore behavior from user
//    expectations. Hard-fail with the locked directive copy. Config
//    loading happens BEFORE the D22 lock (config touches
//    `.viberevert.yml`, not session state, so it's outside the lock's
//    scope per D22's "Lock locations + scope (locked)").
//
// 2. **D16/D17c: git invocation through @viberevert/git only.** This
//    command MUST NOT import `child_process`. Checkpoint creation
//    happens via `git.createCheckpoint`; pre-session porcelain text
//    via `git.getStatusPorcelainText`. The architectural-invariants
//    test from Step 3f polices `cli/src/commands/**`.
//
// 3. **D22: start-lock around all session-state I/O.** The
//    `.viberevert/.locks/start.lock/` mkdir-based exclusive lock is
//    acquired BEFORE `loadActiveSessionLock` and held through the
//    final `active-session.json` write. Closes the race where two
//    concurrent `viberevert start` invocations could both pass the
//    pre-write lock check and both write to active-session.json.
//
// 4. **D17b: locked orchestration order — pre-check active lock,
//    generate sessionId, create tmp dir, write inner checkpoint
//    INSIDE tmp dir, fetch git status AFTER checkpoint (state is
//    unchanged), call core.startSession.** The pre-check on
//    `active-session.json` happens FIRST inside the lock — without
//    it, an already-active session would still trigger checkpoint
//    creation, getStatusPorcelainText, etc., wasting expensive work
//    and risking that an unrelated checkpoint error surfaces instead
//    of the correct D11 refusal. Core's `startSession` re-checks the
//    lock internally (defensive against the narrow race between our
//    pre-check and its re-check), then writes session-state files,
//    renames the tmp dir to `sess_<ULID>/`, and writes
//    `active-session.json`. The checkpoint id comes from
//    `git.createCheckpoint`'s return (git owns checkpoint identity
//    per D5/D17b).
//
// 5. **session.ts architectural lock #2: deterministic timestamps.**
//    `core.startSession` accepts `startedAt` as a plain string input —
//    it never calls `new Date()` internally. The CLI generates the
//    timestamp here. SessionStateSchema requires second precision
//    (no fractional seconds), so we strip the milliseconds from
//    `toISOString()`.
//
// 6. **D11 refusal copy is locked verbatim.** When `active-session.json`
//    already exists, the refusal lists Session / Started at / Task /
//    Checkpoint with TRUNCATED IDs (matching the plan example), and a
//    "Use:" footer naming ONLY commands that exist in M B
//    (`viberevert sessions`, `viberevert end`). MUST NOT include
//    `viberevert rollback` per D7/D10/D11 — that's M D scope.
//
// 7. **D13/D17c cleanup on failure.** If anything between mkdir(tmp)
//    and core.startSession's rename throws, we attempt `rm -rf` on the
//    tmp session dir. After the rename succeeds (inside startSession),
//    this cleanup is a no-op — the dir is at the final path. If the
//    rename succeeded but the active-lock write failed, the orphan
//    session dir at the final path is preserved on disk; D13 tolerates
//    this and `listSessions` surfaces it as a `crash_interrupted`
//    warning. We do NOT auto-clean orphans (deferred to a future
//    `viberevert gc`).

import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  generateSessionId,
  loadActiveSessionLock,
  loadConfig,
  RepoRootNotFoundError,
  resolveRepoRoot,
  SessionAlreadyActiveError,
  startSession,
} from "@viberevert/core";
import { createCheckpoint, getStatusPorcelainText } from "@viberevert/git";
import { Command, Option } from "clipanion";

import { truncateIdForDisplay } from "../format.js";
import {
  ConcurrentOperationError,
  type LockInfo,
  withExclusiveLock,
} from "../locks.js";

const START_LOCK_REL = ".viberevert/.locks/start.lock";

export class StartCommand extends Command {
  static override paths = [["start"]];

  static override usage = Command.Usage({
    description: "Begin a new session, capturing the pre-session checkpoint",
  });

  task = Option.String("--task", {
    description: "Optional human-readable description of what this session will do",
  });

  override async execute(): Promise<number> {
    // Step 1: resolve repo root (outside the lock).
    let repoRoot: string;
    try {
      repoRoot = resolveRepoRoot();
    } catch (err) {
      if (err instanceof RepoRootNotFoundError) {
        this.context.stderr.write(
          "No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).\n",
        );
        this.context.stderr.write(
          "Run `viberevert init` to create a project here.\n",
        );
        return 1;
      }
      throw err;
    }

    // Step 2: validate --task input (defensive — schema also rejects
    // blank strings, but a clean CLI-level error is friendlier than
    // a deep zod issue).
    if (this.task !== undefined && this.task.trim().length === 0) {
      this.context.stderr.write(
        "--task must not be empty or whitespace-only.\n",
      );
      return 1;
    }

    // Step 3: load+validate config (D19; outside the lock per D22's
    // "config touches .viberevert.yml, not session state" scope).
    let rollbackExcludePatterns: readonly string[];
    try {
      const config = await loadConfig(repoRoot);
      rollbackExcludePatterns = config.rollback?.exclude ?? [];
    } catch (err) {
      if (err instanceof ConfigNotFoundError) {
        this.context.stderr.write(
          "No .viberevert.yml found in this repo.\n",
        );
        this.context.stderr.write("Run:\n");
        this.context.stderr.write("  viberevert init\n\n");
        this.context.stderr.write("to create one.\n");
        return 1;
      }
      if (
        err instanceof ConfigParseError ||
        err instanceof ConfigValidationError
      ) {
        this.context.stderr.write(`Invalid .viberevert.yml: ${err.message}\n`);
        this.context.stderr.write("Fix the file, or re-run:\n");
        this.context.stderr.write("  viberevert init\n\n");
        this.context.stderr.write("to start fresh.\n");
        return 1;
      }
      throw err;
    }

    // Step 4: enter the D22 start-lock. All session-state I/O happens
    // inside `protectedFlow` so the lock covers loadActiveSessionLock
    // → createCheckpoint → startSession → active-lock write atomically
    // with respect to other concurrent `start` invocations.
    const protectedFlow = async (): Promise<{
      sessionId: string;
      checkpointId: string;
      startedAt: string;
    }> => {
      // Step 4a: pre-check the active lock BEFORE doing any expensive
      // work. Without this, an already-active session would still
      // trigger checkpoint creation, getStatusPorcelainText, etc.,
      // wasting time and risking that an unrelated checkpoint error
      // surfaces instead of the correct D11 "session already active"
      // refusal. core.startSession also re-checks the lock internally
      // (defensive against the narrow race between our check and
      // core's check), but doing the pre-check here keeps the happy
      // path fast and the refusal path clean.
      const existing = await loadActiveSessionLock(repoRoot);
      if (existing !== null) {
        throw new SessionAlreadyActiveError(existing);
      }

      // Step 4b: generate session id (core owns session identity per
      // D5/D16). Generated AFTER the active-lock pre-check so we
      // don't waste id-generation work on the refusal path. The id
      // is needed BEFORE tmp dir creation because the tmp dir name
      // is id-bearing per D13's "two temp-naming styles" rule.
      const sessionId = generateSessionId();

      // Step 4c: ensure parent dir exists (idempotent). Per D17b,
      // CLI is the orchestration layer responsible for creating the
      // sessions/ container before the tmp dir.
      const sessionsDirAbs = join(repoRoot, ".viberevert", "sessions");
      await mkdir(sessionsDirAbs, { recursive: true });

      // Step 4d: create the tmp session dir. Id-bearing temp name
      // is OK here (the session id was pre-generated by core, unlike
      // standalone checkpoints where git owns the id and the tmp
      // name is generic).
      const tmpSessionDir = join(sessionsDirAbs, `.tmp-${sessionId}`);
      await mkdir(tmpSessionDir);

      let checkpointId: string;
      let startedAt: string;
      try {
        // Step 4e: create the inner-session checkpoint. Git writes
        // into the tmpSessionDir/checkpoint subdir directly per
        // D17b — no later move/copy needed. Pass sessionId so
        // git.createCheckpoint sets manifest.session_id to the
        // owning session's id (NOT the checkpoint's own id, which
        // is what standalone checkpoints get per D6).
        const checkpointResult = await createCheckpoint({
          repoRoot,
          checkpointDir: join(tmpSessionDir, "checkpoint"),
          rollbackExcludePatterns,
          sessionId,
        });
        checkpointId = checkpointResult.checkpointId;

        // Step 4f: fetch the pre-session git porcelain text. Done
        // AFTER createCheckpoint (working tree state is unchanged
        // by the checkpoint — git just reads + writes to
        // .viberevert/, never touches the working tree).
        const beforeStatusText = await getStatusPorcelainText(repoRoot);

        // Step 4g: generate startedAt with second precision per
        // SessionStateSchema. Default toISOString() includes
        // milliseconds which would fail validation.
        startedAt = `${new Date().toISOString().slice(0, 19)}Z`;

        // Step 4h: hand off to core.startSession. Core writes
        // session-state files, atomically renames the tmp dir to
        // sess_<ULID>/, then atomically writes active-session.json.
        // Throws SessionAlreadyActiveError if active-session.json
        // already exists at start (the narrow race between our
        // pre-check above and core's check here — caught by the
        // outer try for D11 refusal copy).
        await startSession({
          repoRoot,
          tmpSessionDir,
          sessionId,
          checkpointId,
          startedAt,
          beforeStatusText,
          ...(this.task !== undefined ? { task: this.task } : {}),
        });
      } catch (err) {
        // Best-effort cleanup of tmpSessionDir. If the failure
        // happened BEFORE core.startSession's rename, this removes
        // the partial state. If AFTER the rename, this is a no-op
        // (the dir is now at the final path; it surfaces as a
        // crash_interrupted warning per D13). If cleanup itself
        // fails, the original error still propagates.
        await rm(tmpSessionDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }

      return { sessionId, checkpointId, startedAt };
    };

    const lockDir = join(repoRoot, START_LOCK_REL);
    const lockInfo: LockInfo = {
      pid: process.pid,
      command:
        this.task !== undefined
          ? `viberevert start --task ${JSON.stringify(this.task)}`
          : "viberevert start",
      started_at: `${new Date().toISOString().slice(0, 19)}Z`,
      host: hostname(),
    };

    let result: { sessionId: string; checkpointId: string; startedAt: string };
    try {
      result = await withExclusiveLock(lockDir, lockInfo, protectedFlow);
    } catch (err) {
      if (err instanceof SessionAlreadyActiveError) {
        // D11 locked refusal copy. Truncated IDs match the plan's
        // example. "Use:" footer names ONLY M B commands — MUST NOT
        // include `viberevert rollback` (deferred to M D per D7/D10).
        const lock = err.active;
        this.context.stderr.write("A session is already active in this repo.\n\n");
        this.context.stderr.write(
          `Session:     ${truncateIdForDisplay(lock.session_id)}\n`,
        );
        this.context.stderr.write(`Started at:  ${lock.started_at}\n`);
        if (lock.task !== undefined) {
          this.context.stderr.write(`Task:        ${lock.task}\n`);
        }
        this.context.stderr.write(
          `Checkpoint:  ${truncateIdForDisplay(lock.checkpoint_id)}\n`,
        );
        this.context.stderr.write("\nUse:\n");
        this.context.stderr.write("  viberevert sessions\n");
        this.context.stderr.write("  viberevert end\n");
        return 1;
      }
      if (err instanceof ConcurrentOperationError) {
        // D22 locked refusal copy with TWO variants depending on
        // whether lock.json was readable. Path uses forward slashes
        // per D22's platform-neutral copy rule.
        this.context.stderr.write(
          err.info !== null
            ? `Another viberevert operation is already running:\n  command:  ${err.info.command}\n  pid:      ${err.info.pid}\n  since:    ${err.info.started_at}\n\nIf you're sure that command isn't running anymore (e.g., crashed),\nremove this stale lock directory manually:\n  ${START_LOCK_REL}\n`
            : `Another viberevert operation is already running (lock metadata unavailable).\n\nIf you're sure no other viberevert command is running,\nremove this stale lock directory manually:\n  ${START_LOCK_REL}\n`,
        );
        return 1;
      }
      throw err;
    }

    // Step 5: print success summary. Full IDs (NOT truncated) for
    // copy-paste utility — consistent with end.ts's success format.
    this.context.stdout.write("Session started.\n");
    this.context.stdout.write(`ID: ${result.sessionId}\n`);
    if (this.task !== undefined) {
      this.context.stdout.write(`Task: ${this.task}\n`);
    }
    this.context.stdout.write(`Checkpoint: ${result.checkpointId}\n`);
    this.context.stdout.write(`Started: ${result.startedAt}\n`);
    return 0;
  }
}
