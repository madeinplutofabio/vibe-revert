# `viberevert rollback` — Contract & Refusal Rules

Canonical contract surface for `viberevert rollback`. Read this before automating rollback in CI, in pre-commit / post-failure hooks, or wrapping it in higher-level tooling.

This document is the source of truth for the command's locked behavior. The CLI's `--help`, the receipt renderer's text, and integration code should all match what's described here. When in doubt, this file wins.

---

## Two engines behind one command

`viberevert rollback` drives two different engines, and which one runs is decided entirely by whether you supplied a selector.

| | No selector | Any selector |
|---|---|---|
| Engine | whole-session restore (M D) | selective restore (0.8.0) |
| Restores | everything the checkpoint captured | only the selected change groups |
| Evidence it needs | the session's checkpoint | the checkpoint **and** the session's durable contribution |
| Receipt schema | `ReceiptFile` | `SelectiveRollbackReceipt` |

Supplying **any** selector, including `--except` on its own, is what enters selective mode. Everything in this document that predates the "Selective rollback" section describes the whole-session engine and is unchanged.

Sessions ended before 0.8.0 have no contribution, so selective mode refuses on them. Whole-session rollback keeps working for those sessions exactly as before.

---

## Synopsis

```sh
viberevert rollback <session-id>                       # dry-run (default; safe; produces receipt)
viberevert rollback <session-id> --apply               # mutate the working tree
viberevert rollback <session-id> --apply --force       # bypass dirty-tree / HEAD-mismatch / legacy-session safety preconditions
viberevert rollback <session-id> --json                # JSON output (mutually exclusive with --markdown)
viberevert rollback <session-id> --markdown            # CommonMark output (mutually exclusive with --json)

# Selective mode: any one of these enters it
viberevert rollback <session-id> --only 'payments/**'
viberevert rollback <session-id> --except 'tests/**'
viberevert rollback <session-id> --risk high
viberevert rollback <session-id> --finding fnd_<64 hex>
```

`<session-id>` MUST match `^sess_[0-9A-HJKMNP-TV-Z]{26}$` (Crockford ULID with the `sess_` prefix).

**Mutual exclusion**: `--json` and `--markdown` together → exit 1. `--force` without `--apply` → exit 1 (dry-run never needs `--force`; allowing it would create ambiguity about whether `forced: true` in a dry-run receipt means anything).

**Selector validation is pre-lock**, alongside the session-id check: `--risk` must be one of `low`, `medium`, `high`, `critical`, and `--finding` must be a full `fnd_<64 lowercase hex>` id. Both refuse with exit 1 before any rollback state is read.

---

## What whole-session rollback does

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

## Selective rollback

Added in 0.8.0. Restores only the change groups the selectors resolve to, and leaves every other managed path provably untouched.

### Selectors

| Selector | Repeatable | Matches against |
|---|---|---|
| `--only <glob>` | yes, union | every alias in a change group, including a rename's previous path |
| `--except <glob>` | yes, union, subtracted last | same alias set |
| `--risk <level>` | no, single threshold | change groups a finding at or above that level touches |
| `--finding <id>` | yes, union | the change groups a finding's `affected_paths` belong to |

Resolution order and combination rules:

- The initial universe is every change group in the contribution.
- Positive families (`--only`, `--risk`, `--finding`) **intersect**. `--only 'payments/**' --risk critical` means critical changes inside `payments/`, never payments plus unrelated critical files.
- A supplied positive family participates even when it resolves to nothing, so `--only 'does/not/exist/**' --risk critical` is empty rather than the critical groups.
- `--except` is subtracted last.
- **Exclusion is group-atomic.** Excluding any path in a rename or type group excludes the whole group.
- `--risk` is an at-or-above threshold over `low < medium < high < critical`. `--risk high` covers high and critical. A change group no finding touches has no risk and is not selected at any threshold, so `--risk low` does not mean "everything".

`--risk` and `--finding` read a session report, so they additionally require `viberevert check --since <session>` to have been run and its `source_contribution_sha256` to match the session's current contribution. A stale or missing report refuses rather than resolving to nothing.

### Eligibility is all-or-nothing

If any selected path fails preflight, no mutation begins. Selected units are never intentionally skipped. Dry-run classifies each selected path as one of:

- `restored`: would be restored
- `already_at_before`: already at its pre-session state; a repeat restore is a no-op, not drift
- `modified_since`: changed since the session ended; refuses
- `unsupported_state`: outside the representable domain
- `missing_evidence`: the checkpoint cannot reconstruct this path's asserted before-state

The receipt's `eligibility` is `eligible`, `ineligible`, or `empty_selection`.

### Receipts

Selective mode writes a different artifact from whole-session mode, at a different path.

```
# dry run, one per session, regenerable, overwritten freely
.viberevert/sessions/<session-id>/selective-rollback-dry-run-receipt.json

# apply, one per invocation, immutable
.viberevert/sessions/<session-id>/rollbacks/<rb_ULID>/receipt.json
```

The preview receipt deliberately lives OUTSIDE `rollbacks/`. A receipt sitting in an invocation directory with no sibling attempt marker is what the history scan treats as inconsistent, and that fails closed. A preview mutates nothing and must never block a later apply.

**An empty selection still writes a dry-run receipt**, with `eligibility: "empty_selection"` and empty results. Under `--apply` an empty selection refuses instead, with no marker and no receipt: there is nothing to authorize, and the attempt marker cannot express a selection resolving to no change group.

### The attempt marker and the crash gap

Before the first worktree or index mutation, a selective apply publishes an immutable marker at:

```
.viberevert/sessions/<session-id>/rollbacks/<rb_ULID>/attempt.json
```

It records `rollback_id`, `session_id`, `contribution_sha256`, the resolved selection, `pre_rollback_checkpoint_id`, and `state: "mutation_may_have_started"`. Only once it exists may the repository be mutated.

The pair is the state machine:

| On disk | Means |
|---|---|
| neither file | nothing was ever authorized to mutate |
| marker only | mutation MAY have started and did not finalize |
| marker plus receipt | the invocation completed and the receipt says how |

A marker without its receipt fails every later apply closed and directs recovery through the recorded emergency checkpoint. This is deliberately conservative even when the process died between writing the marker and touching the first file: a false "you may need to recover" is cheap, a false "nothing happened" is not.

### How the two engines interact

Scanned under the rollback lock, before anything is created:

| Prior state | Next operation | Outcome |
|---|---|---|
| Selective apply succeeded | Another selective apply | **Allowed.** The drift gate and `already_at_before` account for the prior work. |
| Selective apply did not finalize | Any apply | **Refused.** Recover from that invocation's emergency checkpoint first. |
| Whole-session apply receipt exists | Selective apply | **Refused.** The tree is no longer trusted as post-session state. |
| Selective apply succeeded | Whole-session apply | **Refused.** Use `--only '**'` to finish restoring the rest. |
| Any state | Dry run | **Allowed**, and reports the history. |

Once surgical recovery has begun, control never returns to the whole-checkpoint engine, which has no way to reason about a tree already modified by selective operations. The intended progression is:

```sh
viberevert rollback <session> --risk critical --apply
viberevert rollback <session> --risk high --apply
viberevert rollback <session> --only '**' --apply
```

### Verification

Two integrity passes run around the project's own verification commands:

1. After the transplant: every selected path matches the oracle, and every unselected managed path matches the pre-operation snapshot.
2. After the commands: the same comparison again, **including HEAD**, because a configured command could run `git commit` and leave file bytes acceptable while history moved.

`rollback.exclude` applies to the untracked surface only. A tracked path matching an exclude pattern is still captured, still selectable, still restored, and still verified. Selective mode reads the exclude list from the session-start snapshot, never from live config.

### Refusals specific to selective mode

Each exits 1 and writes nothing.

| Refusal | When |
|---|---|
| No contribution | The session predates 0.8.0, or ended without one. Whole-session rollback still works. |
| Report required | `--risk` or `--finding` supplied with no session report. |
| Stale report | The report's `source_contribution_sha256` does not match this session's contribution. |
| Finding not found / has no restorable path | The id resolves to nothing, or to an advisory finding that names no changed file. |
| Empty selection under `--apply` | The selectors matched no change group. |
| Prior apply incomplete | An invocation left a marker with no receipt. |
| Selective already applied, then whole-session apply | See the interaction table above. |
| History unreadable | The rollback history could not be established, so no apply can be authorized. |

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

**Session-only target.** `viberevert rollback <session>` is the only invocation. Checkpoint-direct rollback (`viberevert rollback --checkpoint <cp_id>`) is deferred to a future small enhancement, the same precedent style as M C's `viberevert reports` listing deferral.

**`--finding` takes full ids only.** The selection semantics allow an unambiguous short prefix, but the attempt marker must persist the resolved full id, and the resolver does not yet report which id a prefix matched. A prefix is refused before the lock rather than persisted as itself, which would leave a marker unreadable after a crash. Full ids are printed by `viberevert check --since <session> --json`.

**Selective mode requires a contribution.** Sessions ended before 0.8.0 have none and cannot be back-filled; their after-state is physically gone. See `MIGRATIONS.md`.

**No automatic recovery from crashed sessions.** Sessions that crashed before `viberevert end` could capture the after-status snapshot require `--apply --force` to roll back. A future M B enhancement (e.g., `viberevert sessions --gc` or `--reconcile`) may close this loop by reconstructing the snapshot from current git state.

**No GC of pre-rollback emergency checkpoints.** Every `--apply` writes a new `cp_<ULID>` under `.viberevert/checkpoints/`. With heavy use, the directory grows. The receipt's `pre_rollback_checkpoint_id` makes the linkage explicit so a future `viberevert gc` can prune unreferenced ones safely.

**No receipt size cap.** Sessions touching thousands of files produce large `results[]` arrays. A future enhancement (analogous to M C's noise-budget caps for check reports) may add caps.
