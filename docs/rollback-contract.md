# `viberevert rollback` — Contract & Refusal Rules

Canonical contract surface for `viberevert rollback`. Read this before automating rollback in CI, in pre-commit / post-failure hooks, or wrapping it in higher-level tooling.

This document is the source of truth for M D's locked behavior. The CLI's `--help`, the receipt renderer's text, and integration code should all match what's described here. When in doubt, this file wins.

---

## Synopsis

```sh
viberevert rollback <session-id>                       # dry-run (default; safe; produces receipt)
viberevert rollback <session-id> --apply               # mutate the working tree
viberevert rollback <session-id> --apply --force       # bypass dirty-tree / HEAD-mismatch / legacy-session safety preconditions
viberevert rollback <session-id> --json                # JSON output (mutually exclusive with --markdown)
viberevert rollback <session-id> --markdown            # CommonMark output (mutually exclusive with --json)
```

`<session-id>` MUST match `^sess_[0-9A-HJKMNP-TV-Z]{26}$` (Crockford ULID with the `sess_` prefix).

**Mutual exclusion**: `--json` and `--markdown` together → exit 1. `--force` without `--apply` → exit 1 (dry-run never needs `--force`; allowing it would create ambiguity about whether `forced: true` in a dry-run receipt means anything).

---

## What rollback does

Restores the working tree to the state captured by the session's pre-session checkpoint (the checkpoint created automatically when `viberevert start` ran). Specifically:

- Tracked files: restored via patch replay.
- Untracked files captured at session start: restored via tarball extraction.
- Untracked files NOT captured at session start (anything the session created or anything created after `end`): DELETED.
- Index: restored to match the captured state.
- HEAD: NOT moved. Rollback assumes `git HEAD` matches the captured checkpoint's HEAD SHA; if it doesn't, see HEAD-mismatch below.

---

## Default behavior: dry-run

The default invocation is **dry-run** — produces the receipt that describes what `--apply` WOULD do, without mutating the working tree. This is always safe to run repeatedly.

Dry-run receipts are persisted to:

```
.viberevert/sessions/<session-id>/rollback-dry-run-receipt.json
```

`--apply` is required to actually mutate. Apply receipts are persisted to:

```
.viberevert/sessions/<session-id>/rollback-receipt.json
```

**The two paths are deliberately distinct.** Dry-run can be re-run after a successful apply without overwriting the apply audit record (which would break the re-apply refusal — see "Re-running rollback" below).

---

## The receipt artifact

Every rollback invocation (dry-run AND apply) persists a structured receipt at one of the two paths above. The receipt is the source of truth for what happened:

```jsonc
{
  "schema_version": "1.0",
  "rollback_id": "rb_<ULID>",                  // per-invocation
  "session_id": "sess_<ULID>",                 // the rolled-back session
  "checkpoint_id": "cp_<ULID>",                // the session's inner checkpoint
  "mode": "dry_run",                           // or "apply"
  "forced": false,                             // true iff --force was used
  "written_at": "2026-01-01T00:00:00Z",        // ISO 8601, seconds precision
  "pre_rollback_checkpoint_id": null,          // null in dry-run; cp_<ULID> in apply
  "results": [
    { "path": "src/foo.ts", "outcome": "tracked_restored" }
  ],
  "failures": [],                              // populated on restoreCheckpoint throw
  "forced_unrelated_dirty_paths": [],          // unrelated dirty paths --force accepted
  "dirty_tree_check": "performed",             // or "skipped_no_after_state"
  "out_of_scope_notice": "<verbatim text>",    // see "Out-of-scope boundary" below
  "active_session_warning": true,              // present iff dry-run on active session
  "un_ended_session_warning": true             // present iff after-status.z missing
}
```

`outcome` enum values for each `results[]` entry:

- `tracked_restored` / `untracked_restored` — restored to captured content (or would, dry-run)
- `untracked_deleted` — uncaptured-untracked path removed (or would, dry-run)
- `skipped_excluded` — matched `rollback.exclude` config; left untouched
- `skipped_unchanged` — already byte-identical to captured state; no-op
- `skipped_unrelated_dirt` — **DRY-RUN ONLY**: an unrelated dirty path that `--apply` would refuse on
- `failed` — restore reported an error involving this path; see `failures[]`

`failures[]` `error_code` enum:

- `head_mismatch` / `exclude_drift` / `extraction_conflict` / `tracked_dirty_parity` / `verification` / `internal`

---

## Refusal conditions

Rollback's safety belt. Each refusal exits 1 with a clear message. Some are overrideable by `--force`; some are not (see the next section).

| # | Refusal | When | `--force` overrides? | Mode |
|---|---|---|---|---|
| 1 | Invalid `<session-id>` shape | Positional doesn't match `sess_<ULID>` regex | — | both |
| 2 | Flag conflict | `--json` + `--markdown` OR `--force` without `--apply` | — | both |
| 3 | Config missing | No `.viberevert.yml` in repo | — | both |
| 4 | Lock contention | Another `viberevert rollback` is running in the same repo | — | both |
| 5 | Active-session refusal | Target session is currently active (matches `active-session.json`) | **NO** | apply |
| 6 | Session not found | `<session-id>` doesn't resolve | **NO** | both |
| 7 | Checkpoint artifacts missing/corrupt | Session's inner checkpoint can't be loaded | **NO** | both |
| 8 | Already-applied refusal | Apply receipt exists with `mode: "apply"` | **NO** | apply |
| 9 | HEAD-mismatch | Current `HEAD` differs from captured `manifest.git.head_sha` | **YES** | apply |
| 10 | Un-ended-session refusal | No machine-readable after-status snapshot (`after-status.z`) for this session | **YES** | apply |
| 11 | Dirty-tree refusal | Working tree has dirty paths NOT in the session's expected target set | **YES** | apply |
| 12 | Pre-rollback checkpoint failure | `--apply`'s mandatory emergency checkpoint couldn't be created | — | apply |
| 13 | Post-restore verification failure | `restoreCheckpoint` threw mid-mutation | — | apply |

**Dry-run never refuses on 5, 9, 10, 11.** It surfaces the same conditions as receipt fields (`active_session_warning`, `un_ended_session_warning`, `dirty_tree_check`, `skipped_unrelated_dirt` outcomes) so you can see what `--apply` would do without committing.

---

## `--force` semantics — the canonical override table

> **`--force` means "I accept local safety risk." NOT "ignore broken lifecycle/state invariants."**

| Refusal | `--force` overrides? | Rationale |
|---|---|---|
| Dirty-tree (#11) | **YES** | Safety precondition. Emergency checkpoint still required. The unrelated dirt paths are recorded in `forced_unrelated_dirty_paths` for audit. |
| HEAD-mismatch (#9) | **YES** | Safety precondition. Propagates `allowHeadMismatch: true` into the restore (real override, not just a pre-check bypass). User accepts the risk of applying captured patches onto a different HEAD; restore-correctness verification may still fail. |
| Un-ended-session (#10) | **YES** | Safety-precondition failure (no comparison base for dirty-tree). With `--force`, dirty-tree check is skipped (no after-status snapshot to compare against). Receipt records `un_ended_session_warning: true`, `dirty_tree_check: "skipped_no_after_state"`. Emergency checkpoint still required. |
| Active-session (#5) | **NO** | State-machine invariant. Active session must be ended explicitly (`viberevert end`) before rollback. |
| Already-applied (#8) | **NO** | Idempotency invariant. Re-applying rollback is never the right answer; use the pre-rollback checkpoint to recover from the previous rollback (future enhancement: `viberevert rollback --checkpoint <cp_id>`). |
| Session-not-found (#6) | **NO** | No evidence, no rollback. |
| Checkpoint missing/corrupt (#7) | **NO** | No evidence, no rollback. |
| Lock contention (#4) | **NO** | Active live process; wait or kill the other rollback. |
| Post-restore verification (#13) | **NO** | Restore failure, NOT a refusal decision. `--force` is a CLI-layer pre-check bypass; post-mutation errors surface unconditionally in `failures[]`. |

**`forced_unrelated_dirty_paths` field semantics (locked):**

This field records **the unrelated dirty paths whose refusal was overridden by `--force`** — i.e., the specific paths `--force` accepted past the dirty-tree refusal (#11). It does NOT claim that rollback touched, mutated, or restored those paths. Restore mutation outcomes go elsewhere:

- `results[]` carries per-path success classifications (e.g., `tracked_restored`).
- `failures[]` carries per-path errors with `error_code` + `affected_paths`.

A reader sees "force accepted these specific unrelated paths" SEPARATELY from "restore did/didn't touch them." The two concerns don't overlap.

**Path-level safety model**: D61's dirty-tree check is PATH-BASED, not content-based. A session-touched file that's edited AGAIN after `end` is STILL considered part of the rollback target (its path was in the expected set when `end` ran). **`--force` is NOT protective for session-touched paths** — once a path is in the rollback target set, restore will overwrite it regardless of `--force`. If you have sensitive post-end edits to session-touched paths, **commit, stash, copy, or move them before rollback**. `--force` only bypasses the *refusal* on UNRELATED-dirt paths (paths NOT in the target set).

---

## Emergency pre-rollback checkpoint

Before any `--apply` mutation, the CLI auto-creates a NEW standalone checkpoint capturing the current working-tree state. Stored at:

```
.viberevert/checkpoints/cp_<ULID>/
```

Named `pre-rollback-<truncated-target-sess>` (with suffix `-2`, `-3` on name collision).

The new checkpoint id is recorded in the receipt as `pre_rollback_checkpoint_id` so you can recover via manual `git`/`@viberevert/git` access if a rollback goes wrong. Skipped in dry-run mode (receipt records `pre_rollback_checkpoint_id: null`).

The emergency checkpoint uses the CURRENT resolved config's `rollback.exclude` patterns — same as normal checkpoint capture. It does NOT silently widen capture scope.

**If the emergency checkpoint fails to create, rollback aborts before any restore mutation.** We never mutate without a recoverable pre-state snapshot.

---

## Out-of-scope boundary

Vibe-revert restores **filesystem state managed by git** — tracked file content, untracked file content, and the index. It does NOT restore:

- Database schemas, migrations, or data
- Deployed artifacts (Docker images, k8s manifests applied to clusters, CDN-cached content)
- Package registry publishes (npm publish, pypi upload, etc.)
- External API state (3rd-party service calls, webhook deliveries, payment captures)
- Environment variable mutations in the parent shell
- OS-level state outside the repo (installed packages, config files, network state)
- Any process-side effects (logs sent, emails sent, notifications fired)

If your session caused any of the above, you must reverse them manually.

**The receipt's `out_of_scope_notice` field carries this literal string verbatim** (locked as `ROLLBACK_OUT_OF_SCOPE_NOTICE` in `@viberevert/session-format`):

```
Vibe-revert restores tracked file content, untracked file content, and the git index. It does NOT restore: database schemas/data, deployed artifacts, package registry publishes (npm/pypi/etc.), external API state, environment variable mutations in the parent shell, OS-level state outside the repo, or any process-side effects. Recover those manually.
```

This is the canonical wording. Code referencing it (renderer text, schema literal, this doc) MUST stay in sync.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Successful rollback (`--apply` clean) OR successful dry-run. Receipt persisted in both cases. |
| 1 | Any refusal OR error: config missing, session/checkpoint missing, refusal conditions 5–13, lock contention, I/O failure writing the receipt, invalid `--session` shape, internal exception, post-restore verification error. |
| 2 | **Reserved; NOT used by rollback.** Unlike `viberevert check` (which uses exit 2 for "ran but found a policy violation"), rollback has no policy-gate analog. Partial-mutation failures still exit 1 with the receipt persisted carrying structured `failures[]`. |

CI scripts: distinguish 0 from 1 only.

---

## Re-running rollback

**Dry-run can be re-run any number of times.** Each run overwrites `rollback-dry-run-receipt.json` atomically. No state-machine concerns; dry-run is read-only with respect to the working tree.

**`--apply` after a successful `--apply` is REFUSED.** Once a session has been rolled back, its working tree IS the captured baseline; re-applying would restore captured state onto a tree that's no longer the post-session state — semantically incoherent. The refusal copy directs you to:

- Re-run dry-run to inspect the current state (most `results[]` entries will be `skipped_unchanged`).
- Recover from the previous rollback via the `pre_rollback_checkpoint_id` recorded in the previous apply receipt.

`--force` does NOT bypass this refusal. Idempotency is a state-machine invariant, not a safety check.

---

## Legacy session handling

M D introduces a new machine-readable end-of-session snapshot at:

```
.viberevert/sessions/<session-id>/after-status.z
```

This file is `git status --porcelain=v1 -z` output written atomically alongside the existing `after-status.txt` (which is `git status --porcelain=v1` text — D8 audit-only, **NEVER parsed for machine logic**). The z-format snapshot is what the dirty-tree check (#11) uses to distinguish session-related dirt from unrelated local edits.

Sessions ended BEFORE M D shipped have only `after-status.txt`, not `after-status.z`. These sessions hit the "un-ended" refusal (#10) and require `--apply --force` to roll back. The refusal copy is honest about this:

> Session `<id>` has no machine-readable after-status snapshot. The dirty-tree safety comparison requires the post-session machine snapshot. Run `viberevert end` to capture it if the session is still recoverable, then re-run rollback. If the session is unrecoverable or was created before rollback snapshots existed, and you accept the safety-precondition gap, re-run with `--apply --force`.

When `--force` proceeds on a legacy session: the dirty-tree check is skipped entirely (no comparison base), receipt records `un_ended_session_warning: true` + `dirty_tree_check: "skipped_no_after_state"`. The emergency pre-rollback checkpoint is still mandatory — that's the recovery mechanism for everything that happens next.

`after-status.txt` continues to exist for AUDIT purposes (per D8). It is intentionally NOT parsed for machine safety decisions; v1 text format requires quoting/escaping handling that risks parser drift. Machine logic uses the z-format snapshot exclusively.

---

## Interaction with `viberevert check` reports

A persisted `report.json` from `viberevert check` reflects the diff at check time. After rollback, the diff base (the session's inner checkpoint) IS the restored working-tree state, so a re-`viberevert check --since <sess>` would produce a new report with empty `results[]`.

**The old `report.json` is NOT invalidated or rewritten by rollback** — it remains a historical record of the session's risk findings. To refresh, re-run `viberevert check` against the rolled-back session.

`viberevert check` reports include a `rollback_available: bool` field. After M D, this field is `true` only when the report's diff base is session-bound AND the session's checkpoint artifacts can be loaded. Ad-hoc reports (checkpoint-name, checkpoint-id, git-ref bases) always emit `rollback_available: false`. This is per D72.

---

## Common workflows

### Workflow A: agent broke something during a session

```sh
viberevert start --task "feature X"
# ... agent does work ...
viberevert end
# inspect what happened: agent's changes look bad
viberevert rollback <session-id>             # dry-run: see what rollback would do
viberevert rollback <session-id> --apply     # apply the rollback
```

### Workflow B: rollback on a session with unrelated local edits

```sh
viberevert rollback <session-id> --apply
# refused: unrelated dirty paths

# Either set aside the local edits first:
git stash
viberevert rollback <session-id> --apply     # now clean

# Or accept the risk explicitly (emergency checkpoint protects you):
viberevert rollback <session-id> --apply --force
# Inspect receipt's forced_unrelated_dirty_paths to see what got force-accepted.
```

### Workflow C: pre-commit hook gates on `viberevert check`

```sh
#!/bin/sh
# .git/hooks/pre-commit
viberevert check
if [ $? -eq 2 ]; then
  echo "Vibe-check found blockers."
  echo "To inspect: viberevert report"
  echo "To roll back the active session: viberevert end && viberevert rollback <session-id>"
  exit 1
fi
```

### Workflow D: recovering from a bad rollback

```sh
viberevert rollback <session> --apply   # rollback applied; but the result looks worse

# The apply receipt has pre_rollback_checkpoint_id pointing to a checkpoint capturing
# the post-session state right before this rollback. To recover that state:
cat .viberevert/sessions/<session>/rollback-receipt.json | jq .pre_rollback_checkpoint_id

# Then manually restore via @viberevert/git, OR wait for future enhancement:
#   viberevert rollback --checkpoint <pre_rollback_checkpoint_id>
```

---

## Concurrency

Only one `viberevert rollback` operation runs at a time per repo. The lock is `.viberevert/.locks/rollback.lock/` (mkdir-based, advisory). Both dry-run AND apply acquire it. Lock contention → exit 1 with `ConcurrentOperationError`.

This differs from `viberevert check` (which is lock-free — non-mutating + idempotent). Rollback mutates and the receipt write is itself trust-critical, so the lock encloses the entire metadata-load → refusal-decisions → mutate → persist arc.

---

## Limitations + future direction

**Path-based, not content-based.** A session-touched file that's reverted to its pre-session content after `end` is still classified as session-related (path is in the target set). Content-level safety would require persisting per-file hashes alongside the after-status snapshot; deferred to a future enhancement.

**Session-only target.** `viberevert rollback <session>` is the only invocation in M D. Checkpoint-direct rollback (`viberevert rollback --checkpoint <cp_id>`) is deferred to a future small enhancement — same precedent style as M C's `viberevert reports` listing deferral.

**No automatic recovery from crashed sessions.** Sessions that crashed before `viberevert end` could capture the after-status snapshot require `--apply --force` to roll back. A future M B enhancement (e.g., `viberevert sessions --gc` or `--reconcile`) may close this loop by reconstructing the snapshot from current git state.

**No GC of pre-rollback emergency checkpoints.** Every `--apply` writes a new `cp_<ULID>` under `.viberevert/checkpoints/`. With heavy use, the directory grows. The receipt's `pre_rollback_checkpoint_id` makes the linkage explicit so a future `viberevert gc` can prune unreferenced ones safely.

**No receipt size cap.** Sessions touching thousands of files produce large `results[]` arrays. A future enhancement (analogous to M C's noise-budget caps for check reports) may add caps.
