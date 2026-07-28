# ADR 0002: State-based rollback

- Status: Accepted — 2026-07-28 (records a decision shipped in Milestone D)
- Milestone: D (rollback); recorded in H8.4
- Related: [rollback contract](../rollback-contract.md), [rollback limitations](../rollback-limitations.md); `packages/git/src/checkpoint.ts`, `packages/git/src/restore.ts`

## Context

VibeRevert needs to preserve supported pre-session working-tree and index state,
including changes the user has not committed. An AI agent typically edits the
working tree directly, so at the moment a session starts, the state at risk is the
working tree and index (tracked edits, staged changes, and untracked files), most
of which is not in any commit.

Git's commit-history recovery mechanisms operate primarily on committed state.
`git reset`, `git revert`, and the reflog can move between or invert commits, but
they do not reconstruct uncommitted or untracked content that was never
committed — which is exactly the content most at risk during a session.

## Decisions

### 1. A session captures the pre-session working-tree state as a snapshot

When a session starts, VibeRevert records a checkpoint of the working tree at that
moment: the tracked-file diff (staged and unstaged), an archive of dirty tracked
content, and an archive of the untracked files present, together with the index
and the current HEAD commit. The snapshot — not git history — is the source of
truth for what "before" was. See `packages/git/src/checkpoint.ts`.

### 2. Rollback restores the snapshot; it does not move HEAD

Applying a rollback replays that snapshot onto the working tree and index and
leaves the current commit unchanged. By default, a mismatch between the current
HEAD and the checkpoint's recorded HEAD is a refusal condition; `--force` may
bypass that specific check, but rollback still never moves HEAD. This restores
uncommitted and untracked pre-session state that a commit-based undo could not.

### 3. Rollback is non-atomic, guarded by a mandatory emergency checkpoint

Replaying a snapshot is a multi-step mutation (patch application, archive
extraction, cleanup) and can fail partway. Rather than promise atomicity, an
`--apply` first writes a fresh emergency checkpoint of the current state and
aborts before any mutation if that checkpoint cannot be created. A partial failure
is reported with structured per-path results and is never treated as success; the
emergency checkpoint is the designated recovery source.

### 4. Rollback is a preview by default and scoped to captured file state

Rollback is a dry-run until `--apply` is given, and it restores only repository
file state within the configured scope. Effects outside the repository — executed
database migrations, deployments, published packages — are out of scope. The full
refusal rules, receipts, and scope boundary are specified in the
[rollback contract](../rollback-contract.md) and
[rollback limitations](../rollback-limitations.md).

## Alternatives considered

- **`git reset --hard` to a pre-session commit.** Requires the pre-session state
  to be a commit, discards uncommitted work, cannot restore untracked files, and
  moves HEAD — the opposite of preserving in-progress work.
- **A stash-based checkpoint.** `git stash` can capture tracked state and, with
  explicit options, untracked files. VibeRevert instead uses its own checkpoint
  artifacts so the captured state, restore inputs, receipts, and failure handling
  are explicit and tied to the session rather than to mutable repository stash
  state.
- **`git revert` or reflog recovery.** Operate on commits only; they cannot
  reconstruct never-committed working-tree state.

## Consequences

- When its preconditions hold and application succeeds, rollback can restore
  supported uncommitted and untracked pre-session state within the captured,
  non-excluded path set. This is possible precisely because state is snapshotted
  rather than derived from history.
- Because rollback is non-atomic, a failed apply may leave a partially restored
  tree. The failure is surfaced and never reported as success. The emergency
  checkpoint provides a recovery source, although recovery may require manual work
  and is not guaranteed to be automatic.
- Each session and checkpoint stores diffs and archives under `.viberevert/`,
  which costs disk space that grows with session count and working-tree size.
- Rollback is path-based, not content-based: a session-touched path edited again
  after the session ends is still part of the rollback target.
