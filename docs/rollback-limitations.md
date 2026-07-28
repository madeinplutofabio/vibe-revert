# Rollback limitations

`viberevert rollback` can restore supported repository file state captured in a
session's pre-session checkpoint. It's important to know exactly what that does
and does not undo. There are two cases: local file state VibeRevert can restore
(Case 1) and external effects it cannot reverse (Case 2). For the full behavior —
refusal rules, receipts, and `--force` semantics — see the
[rollback contract](rollback-contract.md).

## Case 1 — what rollback restores

When rollback is allowed and applied successfully, it restores the captured
working-tree and index state within the configured rollback scope:

- **Tracked files** are restored to their pre-session content.
- **Untracked files that existed at session start** are restored from the
  captured snapshot.
- **The git index** is restored to the captured state.
- **Files the session created** (untracked files that did *not* exist at session
  start) are **removed** — returning to the pre-session state means they go away.

These outcomes apply only to paths captured by the checkpoint and not excluded by
`rollback.exclude`.

Rollback is a **preview (dry-run) by default**; nothing changes until you pass
`--apply`. `HEAD` is never moved. Rollback changes the working tree and index
while leaving the current commit unchanged.

## Case 2 — what rollback cannot reverse

Rollback restores files managed by git. It does **not** reach anything outside
your local repository. If the session caused any of the following, you must undo
them yourself:

- Applied database schema changes and database data. Migration files inside the
  repository remain ordinary Case 1 files.
- Deployed state, such as running containers, cluster resources, or CDN content.
  Repository deployment files remain ordinary Case 1 files.
- Package registry publishes (npm, PyPI, etc.).
- External API calls, webhook deliveries, or payment captures.
- Environment-variable changes in your shell.
- OS-level state outside the repository (installed packages, system config).
- Other process side effects (emails sent, notifications fired, logs shipped).

VibeRevert records this same boundary verbatim in every rollback receipt, so the
scope is explicit in the audit trail.

## Limitations that affect what you get back

Even within Case 1, a few properties shape the result:

- **Rollback is not atomic.** An `--apply` can fail partway through. When it does,
  the failure is reported — never silently treated as success — and VibeRevert
  has already written an emergency checkpoint of the current state so you can
  recover.
- **Matching is path-based, not content-based.** If you edited a file the session
  touched *after* the session ended, that path is still part of the rollback
  target and will be overwritten; `--force` does not protect it. Commit, stash,
  or move such edits aside before rolling back.
- **Excluded paths are left untouched.** Anything matching `rollback.exclude` in
  your [configuration](config.md) is neither restored nor removed.

## Before you roll back

1. Run the dry-run first (the default) to see exactly what would change.
2. Set aside any local edits you want to keep (commit, stash, or copy them).
3. Re-run with `--apply`.

For refusal conditions, receipts, and recovering from a bad rollback, see the
[rollback contract](rollback-contract.md).
