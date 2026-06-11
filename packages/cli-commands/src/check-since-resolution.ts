// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Fabio Marcello Salvadori

// CLI check-since-resolution — narrow policy module that answers ONE
// question: given the repo root, the user's --since/--staged flags, and
// the loaded config context, what base is `viberevert check` checking
// against, and what metadata does the persisted ReportFile need?
//
// Outputs a tagged-union ResolvedCheckBase carrying:
//   - mode:               "git-ref" | "checkpoint" — diff-helper dispatch
//   - kind:               "ad_hoc" | "session_bound" — storage-path
//                          dispatch (file-level vs dir-level atomic
//                          persistence per D26), also consumed by
//                          buildReportFile
//   - sinceKind:          full SinceKind enum value for
//                          ReportFile.since_kind ("git_ref" |
//                          "checkpoint_id" | "checkpoint_name" |
//                          "session_id" | "active_session")
//   - sinceRef:           verbatim user input (post-resolution) for
//                          ReportFile.since_ref
//   - sinceResolvedSha:   canonical 40-char SHA for
//                          ReportFile.since_resolved_sha — already
//                          routed through
//                          `resolveSinceResolvedShaForReport` so the
//                          VIBEREVERT_TEST_FIXED_SHA env-override
//                          applies uniformly
//   - startedAt:          ISO 8601 second-precision for
//                          report.started_at per D31's per-base rule
//                          (git-ref → commit %cI; checkpoint →
//                          manifest.captured_at; session →
//                          session.started_at)
//   - reportId:           the identity that report.session_id AND
//                          wrapper.report_id share per D31's
//                          identity-consistency refine (session_bound
//                          reuses sess_<ULID>; ad_hoc gets fresh
//                          rpt_<ULID> from generateReportId)
//   - checkpointDir:      (checkpoint mode only) path to the manifest
//                          for getDiffSinceCheckpoint
//   - checkpointId:       (session_bound only) the session's bound
//                          checkpoint id, persisted to
//                          report.checkpoint_id
//   - stagedOnly:         true on git-ref + --staged, false otherwise;
//                          never true on the checkpoint branch (D58
//                          mutual-exclusion throws before resolver
//                          returns)
//   - task:               (checkpoint branch only, sinceKind ∈
//                          {session_id, active_session}) base-level
//                          task inherited from session.task. The CLI's
//                          --task flag is applied as an override in
//                          check.ts; THIS resolver does NOT see --task.
//                          The git-ref variant carries `task?:
//                          undefined` for cross-branch type symmetry
//                          under `exactOptionalPropertyTypes`, so
//                          downstream `options.task ?? base.task`
//                          type-checks without union narrowing.
//
// =============================================================================
// Architectural locks (must be preserved by all changes here)
// =============================================================================
//
// 1. **D26 — --since resolution order is locked.** The resolver tries
//    these dispatch arms in this exact order:
//      (a) --since matching `^sess_<ULID>$` regex     → session-bound
//      (b) --since matching `^cp_<ULID>$` regex       → ad-hoc from id
//      (c) --since <name> via findCheckpointByName    → ad-hoc from name
//      (d) --since <other> via resolveCommitRef        → git-ref
//          If (c) returns null AND the (d) initial resolveCommitRef
//          throws CommitRefNotFoundError, throw
//          CheckpointNameNotFoundError naming both failure modes.
//          POST-resolve failures (e.g., getCommitTimestamp's internal
//          re-resolve) propagate UNWRAPPED — the ref already resolved
//          successfully so the "neither name nor ref" message would
//          be a lie.
//      (e) omitted + active session + no --staged     → session-bound
//      (f) omitted + no active session + no --staged  → git-ref HEAD~1
//      (g) omitted + --staged                         → git-ref HEAD
//                                                       with stagedOnly=true
//
// 2. **D58 — --staged mutually exclusive with snapshot bases.** Throws
//    `StagedIncompatibleWithSnapshotBaseError` when --staged combines
//    with any --since that resolves to a checkpoint or session base
//    (cases a, b, c). The error message names what --since resolved to.
//    Per D58 also: when --since is omitted AND --staged is set, the
//    resolver does NOT consult the active-session lock — short-circuits
//    directly to git-ref HEAD.
//
// 3. **D31 — identity-consistency.** reportId is the SAME value the CLI
//    uses for BOTH wrapper.report_id and report.session_id. For
//    session-bound, that's the session's own sess_<ULID>; for ad-hoc, a
//    fresh rpt_<ULID> from generateReportId. The schema refine enforces
//    this — the resolver's job is to surface ONE value to use everywhere.
//
// 4. **D56 — since_resolved_sha is canonical-SHA.** git-ref base resolves
//    via `git.resolveCommitRef` (the package's single source of truth
//    for ref-to-SHA resolution post-D.1.pre). Checkpoint/session bases
//    use the manifest's captured `git.head_sha`. The result is then
//    routed through `resolveSinceResolvedShaForReport` so
//    VIBEREVERT_TEST_FIXED_SHA fires for golden fixtures.
//
// 5. **D31 — startedAt per-base.** git-ref → `git.getCommitTimestamp`
//    (committer date, %cI); checkpoint id/name → manifest.captured_at;
//    session id / active session → session.started_at.
//
// 6. **Narrow error hierarchy.** Two typed errors only:
//    `StagedIncompatibleWithSnapshotBaseError` and
//    `CheckpointNameNotFoundError`. No parent class — check.ts catches
//    each by exact instanceof, a parent would be ceremony without
//    consumers. Other errors propagate from their owner packages
//    unwrapped: `SessionNotFoundError` (core),
//    `CheckpointNotFoundError` / `CheckpointCorruptError` (git),
//    `CommitRefNotFoundError` (git, only on direct git-ref input —
//    wrapped as CheckpointNameNotFoundError on the name-fallback path's
//    INITIAL-resolve failure only),
//    `RuntimeEnvInvalidError` (runtime-env, on bad env override).
//
// 7. **D29 — no CLI output.** No console, no process.stderr writes, no
//    Clipanion. Resolver returns a value; check.ts owns terminal stream
//    writes.
//
// 8. **The resolver does NOT see --task.** Per D28's task precedence
//    rule, --task overrides session.task. The resolver only outputs
//    base-level task (from session.task when the base IS a session).
//    The CLI merges via `(options.task ?? base.task)` at command time.
//
// 9. **Defense-in-depth path-traversal guard.** Active-session lock's
//    `session_id` is validated against `SESSION_ID_RE` BEFORE any
//    `path.join` — ActiveSessionLockSchema only enforces
//    `nonBlankString`, so a manually-edited or corrupted lock could
//    carry a value like `"../.."` that would otherwise escape the
//    intended directory. Mirrors the convention in report-paths.ts.

import { join } from "node:path";

import { generateReportId, loadActiveSessionLock, loadSession } from "@viberevert/core";
import {
  CommitRefNotFoundError,
  findCheckpointByName,
  getCommitTimestamp,
  loadCheckpoint,
  resolveCommitRef,
} from "@viberevert/git";

import { resolveSinceResolvedShaForReport } from "./runtime-env.js";

// =============================================================================
// Canonical id regex (must match the SinceKindSchema-implied shapes)
// =============================================================================

/** Canonical session id: sess_ + 26-char Crockford base32 (excludes I, L, O, U). */
const SESSION_ID_RE = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Canonical checkpoint id: cp_ + 26-char Crockford base32. */
const CHECKPOINT_ID_RE = /^cp_[0-9A-HJKMNP-TV-Z]{26}$/;

const VIBEREVERT_DIR = ".viberevert";
const CHECKPOINTS_SUBDIR = "checkpoints";
const SESSIONS_SUBDIR = "sessions";
const INNER_SESSION_CHECKPOINT_SUBDIR = "checkpoint";

// =============================================================================
// Public types
// =============================================================================

export interface ResolveCheckBaseOptions {
  readonly repoRoot: string;
  /**
   * The raw `--since` flag value, or `undefined` if not passed. The
   * resolver applies pattern dispatch (sess_ → cp_ → name → git ref)
   * AND the omitted-default rules (active session vs HEAD~1 vs HEAD
   * per D26 + D58).
   */
  readonly since?: string;
  /** The `--staged` flag. False if not passed. */
  readonly staged: boolean;
  /**
   * Optional env override (defaults to `process.env`). Passed through
   * to `resolveSinceResolvedShaForReport` so the
   * VIBEREVERT_TEST_FIXED_SHA env-override applies; the resolver
   * itself does NOT branch on this env.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The resolved base + identity metadata `viberevert check` needs to
 * fetch its diff, run its checks, persist its report, and exit with
 * the correct code. Tagged union on `mode`:
 *
 *   - "git-ref"   → call `getDiffSinceRef(repoRoot, sinceRef, {staged})`
 *   - "checkpoint" → call `getDiffSinceCheckpoint(repoRoot,
 *                     checkpointDir, {liveExcludePatterns})`
 *
 * `task` lives on the "checkpoint" variant only with a real string
 * value (set when `sinceKind ∈ {"session_id", "active_session"}` —
 * the two cases where a base-level task exists). The "git-ref"
 * variant carries `task?: undefined` so that downstream code can
 * read `base.task` without prior union narrowing under
 * `exactOptionalPropertyTypes` — the value is always `undefined`
 * on that branch but the property is structurally accessible.
 *
 * `checkpointId` lives on the "checkpoint" variant only, and is set
 * only when `kind === "session_bound"` — the session's bound checkpoint
 * id, persisted to `report.checkpoint_id`.
 */
export type ResolvedCheckBase =
  | {
      readonly mode: "git-ref";
      readonly kind: "ad_hoc";
      readonly sinceKind: "git_ref";
      readonly sinceRef: string;
      readonly sinceResolvedSha: string;
      readonly startedAt: string;
      readonly reportId: string;
      readonly stagedOnly: boolean;
      readonly task?: undefined;
    }
  | {
      readonly mode: "checkpoint";
      readonly kind: "session_bound" | "ad_hoc";
      readonly sinceKind: "checkpoint_id" | "checkpoint_name" | "session_id" | "active_session";
      readonly sinceRef: string;
      readonly sinceResolvedSha: string;
      readonly checkpointDir: string;
      readonly checkpointId?: string;
      readonly startedAt: string;
      readonly reportId: string;
      readonly stagedOnly: false;
      readonly task?: string;
    };

// =============================================================================
// Errors (narrow — two classes, no parent per the "avoid ceremony" rule)
// =============================================================================

/**
 * Thrown when `--staged` is combined with a `--since` value that
 * resolves to a checkpoint or session base. D58 locks these as
 * mutually exclusive: the captured snapshot represents a fully-resolved
 * working state, with no separate "index" axis for staged-only
 * scoping. The error message identifies which base kind the user's
 * `--since` resolved to, so check.ts can render an actionable
 * suggestion.
 */
export class StagedIncompatibleWithSnapshotBaseError extends Error {
  override readonly name = "StagedIncompatibleWithSnapshotBaseError";
  constructor(
    readonly sinceArg: string,
    readonly baseKind: "session" | "checkpoint" | "checkpoint-name",
  ) {
    super(
      `--staged is incompatible with --since ${JSON.stringify(sinceArg)} ` +
        `(${baseKind} base). Use --since <git-ref> or omit --since to scope to staged changes.`,
    );
  }
}

/**
 * Thrown when `--since <value>` is neither a session-id pattern, nor a
 * checkpoint-id pattern, nor a known checkpoint name (via
 * `findCheckpointByName`), nor a valid git ref (the INITIAL
 * `resolveCommitRef` call rejected it). The message names BOTH
 * fallback failure modes so the user knows exactly what was tried.
 *
 * Scope-narrowing rule: only the INITIAL `resolveCommitRef` failure
 * triggers this wrap. Subsequent post-resolve failures (e.g.,
 * `getCommitTimestamp`'s internal re-resolve, which CAN throw
 * CommitRefNotFoundError under repo-state mutation between calls)
 * propagate UNWRAPPED — the ref already resolved successfully and the
 * "neither name nor ref" diagnostic would be a lie.
 *
 * The underlying `CommitRefNotFoundError` from the failed initial
 * git-ref attempt is preserved on `this.cause` via the standard Error
 * options API (non-enumerable per the convention shared with
 * `CommitRefNotFoundError` / `DiffRefNotFoundError`).
 *
 * Diagnostic-safety: the `sinceArg` interpolation uses
 * `JSON.stringify` so newlines, terminal escapes, or text that mimics
 * another error fragment in a user-controlled --since value cannot
 * corrupt the diagnostic line. Same hardening as
 * `CommitRefNotFoundError` and `DiffRefNotFoundError`.
 */
export class CheckpointNameNotFoundError extends Error {
  override readonly name = "CheckpointNameNotFoundError";
  constructor(
    readonly sinceArg: string,
    cause?: unknown,
  ) {
    super(
      `--since ${JSON.stringify(sinceArg)}: not a checkpoint name ` +
        `(no matching checkpoint found) and not a valid git ref (rev-parse failed).`,
      cause === undefined ? undefined : { cause },
    );
  }
}

// =============================================================================
// Path-traversal defense (active-session lock id validation)
// =============================================================================

/**
 * Validate that `sessionId` matches the canonical sess_<ULID> shape
 * BEFORE it enters `path.join`. Used for the active-session lock's
 * on-disk `session_id` field, which the schema constrains only to
 * `nonBlankString` — a manually-edited or corrupted lock could carry
 * `"../.."`, `"/etc/passwd"`, or another path-traversal vector that
 * would otherwise escape the intended `.viberevert/sessions/<id>/`
 * directory.
 *
 * Throws a plain `Error` (not a typed class) — this is a defense for
 * a low-probability misconfiguration, not a user-facing flag-error
 * path. check.ts catches it via the generic error catch and surfaces
 * the message verbatim.
 */
function assertValidSessionId(sessionId: string, context: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `${context}: expected sess_<26-char Crockford ULID>, got ${JSON.stringify(sessionId)}`,
    );
  }
}

// =============================================================================
// Public — resolveCheckBase (the D26 + D58 dispatch entry point)
// =============================================================================

export async function resolveCheckBase(opts: ResolveCheckBaseOptions): Promise<ResolvedCheckBase> {
  const { repoRoot, since, staged, env } = opts;

  // Step 1: --since is set → pattern dispatch per D26 resolution order.
  if (since !== undefined) {
    // 1a. sess_<ULID> pattern → session-bound. D58 staged check FIRST
    // so the user sees the mutual-exclusion error before any disk I/O.
    if (SESSION_ID_RE.test(since)) {
      if (staged) throw new StagedIncompatibleWithSnapshotBaseError(since, "session");
      return resolveFromSessionId(repoRoot, since, "session_id", env);
    }
    // 1b. cp_<ULID> pattern → ad-hoc from id.
    if (CHECKPOINT_ID_RE.test(since)) {
      if (staged) throw new StagedIncompatibleWithSnapshotBaseError(since, "checkpoint");
      return resolveFromCheckpointId(repoRoot, since, env);
    }
    // 1c. Try findCheckpointByName scan. findCheckpointByName returns
    // null for "no match" (NOT throws), so no need for try/catch here.
    const namedCheckpointDir = await findCheckpointByName(repoRoot, since);
    if (namedCheckpointDir !== null) {
      if (staged) throw new StagedIncompatibleWithSnapshotBaseError(since, "checkpoint-name");
      return resolveFromCheckpointDir(namedCheckpointDir, since, "checkpoint_name", env);
    }
    // 1d. Try as git ref. Narrow the wrap to the INITIAL
    // `resolveCommitRef` call only — post-resolve failures
    // (`getCommitTimestamp`'s internal re-resolve, etc.) propagate
    // UNWRAPPED so the "neither name nor ref" diagnostic isn't
    // misreported when the ref clearly DID resolve.
    let realSha: string;
    try {
      realSha = await resolveCommitRef(repoRoot, since);
    } catch (cause) {
      if (cause instanceof CommitRefNotFoundError) {
        throw new CheckpointNameNotFoundError(since, cause);
      }
      throw cause;
    }
    return resolveFromResolvedGitRef(repoRoot, since, realSha, staged, env);
  }

  // Step 2: --since omitted. Per D58, --staged short-circuits the
  // active-session default (do NOT consult the active lock when
  // --staged is set).
  if (staged) {
    return resolveFromGitRef(repoRoot, "HEAD", true, env);
  }

  // 2b. omitted + no --staged → consult active-session lock.
  const activeLock = await loadActiveSessionLock(repoRoot);
  if (activeLock !== null) {
    assertValidSessionId(activeLock.session_id, "active-session lock");
    return resolveFromSessionId(repoRoot, activeLock.session_id, "active_session", env);
  }

  // 2c. omitted + no active session + no --staged → git-ref HEAD~1
  // (per D26 case 3 — "previous commit" is the natural default when
  // no session context exists).
  return resolveFromGitRef(repoRoot, "HEAD~1", false, env);
}

// =============================================================================
// Per-dispatch-arm resolvers (private)
// =============================================================================

async function resolveFromSessionId(
  repoRoot: string,
  sessionId: string,
  sinceKind: "session_id" | "active_session",
  env: NodeJS.ProcessEnv | undefined,
): Promise<ResolvedCheckBase> {
  // loadSession throws SessionNotFoundError if missing — propagate.
  const session = await loadSession(sessionId, repoRoot);
  const checkpointDir = join(
    repoRoot,
    VIBEREVERT_DIR,
    SESSIONS_SUBDIR,
    sessionId,
    INNER_SESSION_CHECKPOINT_SUBDIR,
  );
  // loadCheckpoint throws CheckpointNotFoundError / CheckpointCorruptError
  // — propagate unwrapped. check.ts has typed catches.
  const manifest = await loadCheckpoint(checkpointDir);
  const sinceResolvedSha = resolveSinceResolvedShaForReport(manifest.git.head_sha, env);
  return {
    mode: "checkpoint",
    kind: "session_bound",
    sinceKind,
    sinceRef: sessionId,
    sinceResolvedSha,
    checkpointDir,
    checkpointId: session.checkpoint_id,
    startedAt: session.started_at,
    reportId: sessionId, // D31 identity: session_bound reuses session id
    stagedOnly: false,
    ...(session.task !== undefined ? { task: session.task } : {}),
  };
}

async function resolveFromCheckpointId(
  repoRoot: string,
  checkpointId: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<ResolvedCheckBase> {
  const checkpointDir = join(repoRoot, VIBEREVERT_DIR, CHECKPOINTS_SUBDIR, checkpointId);
  return resolveFromCheckpointDir(checkpointDir, checkpointId, "checkpoint_id", env);
}

async function resolveFromCheckpointDir(
  checkpointDir: string,
  sinceRef: string,
  sinceKind: "checkpoint_id" | "checkpoint_name",
  env: NodeJS.ProcessEnv | undefined,
): Promise<ResolvedCheckBase> {
  const manifest = await loadCheckpoint(checkpointDir);
  const sinceResolvedSha = resolveSinceResolvedShaForReport(manifest.git.head_sha, env);
  return {
    mode: "checkpoint",
    kind: "ad_hoc",
    sinceKind,
    sinceRef,
    sinceResolvedSha,
    checkpointDir,
    startedAt: manifest.captured_at,
    reportId: generateReportId(), // ad-hoc gets fresh rpt_<ULID>
    stagedOnly: false,
  };
}

/**
 * Direct-git-ref dispatch entry. Thin wrapper that runs the initial
 * resolve and hands off to the post-resolve workhorse. Used by the
 * omitted-default dispatch arms (2a, 2c) where any
 * `CommitRefNotFoundError` propagates unwrapped because no name-fallback
 * is in play.
 */
async function resolveFromGitRef(
  repoRoot: string,
  ref: string,
  staged: boolean,
  env: NodeJS.ProcessEnv | undefined,
): Promise<ResolvedCheckBase> {
  const realSha = await resolveCommitRef(repoRoot, ref);
  return resolveFromResolvedGitRef(repoRoot, ref, realSha, staged, env);
}

/**
 * Git-ref post-resolve workhorse. Takes a pre-resolved canonical SHA
 * and produces the ResolvedCheckBase result. Split out from
 * resolveFromGitRef so the name-fallback path (step 1d) can wrap ONLY
 * the initial `resolveCommitRef` failure and let any post-resolve
 * failure (e.g., `getCommitTimestamp`'s internal re-resolve) propagate
 * unwrapped.
 *
 * `getCommitTimestamp` re-resolves internally per the D.1.pre
 * single-source rule — one extra rev-parse vs a hypothetical
 * `getCommitTimestampFromSha` overload. Accepting the small cost to
 * keep git-cli.ts's API surface narrow.
 */
async function resolveFromResolvedGitRef(
  repoRoot: string,
  ref: string,
  realSha: string,
  staged: boolean,
  env: NodeJS.ProcessEnv | undefined,
): Promise<ResolvedCheckBase> {
  const sinceResolvedSha = resolveSinceResolvedShaForReport(realSha, env);
  const startedAt = await getCommitTimestamp(repoRoot, realSha);
  return {
    mode: "git-ref",
    kind: "ad_hoc",
    sinceKind: "git_ref",
    sinceRef: ref,
    sinceResolvedSha,
    startedAt,
    reportId: generateReportId(),
    stagedOnly: staged,
  };
}
