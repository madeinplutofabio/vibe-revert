# Migrations

What changes for existing repositories when VibeRevert's persisted formats
evolve, and what you have to do about it.

The short version for 0.8.0: **nothing breaks, nothing needs migrating, and no
command changes behavior unless you pass a new flag.** Every new schema field is
optional and every existing artifact stays valid and readable.

---

## 0.8.0 Surgical Recovery

0.8.0 adds selective rollback: restoring only part of what a session changed,
rather than all of it. That needs a durable record of what the session
contributed, which earlier versions never captured.

### What is added

| Artifact | Path | Written by |
|---|---|---|
| Session contribution | `.viberevert/sessions/<id>/contribution.json` | `viberevert end` |
| Contribution objects | `.viberevert/objects/` | `viberevert end` |
| Evaluation snapshot | embedded in `session.json` | `viberevert start` |
| Selective preview receipt | `.viberevert/sessions/<id>/selective-rollback-dry-run-receipt.json` | `viberevert rollback <selector>` |
| Attempt marker plus receipt | `.viberevert/sessions/<id>/rollbacks/<rb_ULID>/` | `viberevert rollback <selector> --apply` |

`session.json` gains `contribution_path`, `contribution_sha256` and
`evaluation_snapshot`; check reports gain `source_contribution_sha256`, and
findings gain `finding_id` and `affected_paths`. All optional.

### There is no migration step

You do not run anything. There is no `viberevert migrate`, and no upgrade
rewrites an existing file.

- Existing `session.json`, `report.json`, checkpoints and rollback receipts stay
  valid and are read exactly as before.
- The new fields are optional, so a record written by an older version parses
  under 0.8.0 unchanged.
- Whole-session rollback is untouched. Same refusals, same receipts, same paths,
  same exit codes.

### What older sessions can and cannot do

Which capabilities a session has depends on when it started and when it ended,
because the evidence is captured at those two moments and cannot be recreated
afterwards.

| Session | Selective rollback | `--risk` / `--finding` | Verification commands | Whole-session rollback |
|---|---|---|---|---|
| Started and ended under 0.8.0 | yes | yes | yes | yes |
| Started before 0.8.0, still active at upgrade, ended under 0.8.0 | yes, path selectors only | no | no | yes |
| Ended before 0.8.0 | no | no | no | **yes, unchanged** |

**A session ended before 0.8.0 cannot be back-filled.** Its after-state is
physically gone: earlier versions recorded only path sets at `end`, with no
content, digests or index state, and the working tree has moved on since. There
is no honest way to reconstruct what the session contributed, so selective
rollback refuses rather than guessing. Whole-session rollback keeps working on
those sessions exactly as it always has, which is the recovery path they were
designed for.

**A session that was still active when you upgraded is supported.** Its
checkpoint exists and its after-state is still on disk, so its contribution is
captured normally when it ends. It has no evaluation snapshot, because that is
written at `start`, which already happened. The consequences:

- Path selectors, `--only` and `--except`, work.
- `--risk` and `--finding` do not, since they resolve against a report bound to
  a snapshot that does not exist.
- Verification commands do not run for it.
- For the untracked surface, the exclude policy falls back to
  `manifest.untracked.exclude_patterns`, the list persisted in that session's own
  checkpoint at capture time, so path-only recovery has a defined policy source
  rather than an implied one.

### Things worth knowing before you rely on it

**`.viberevert/objects/` grows.** Contribution capture stores changed content
there, content-addressed and deduplicated. Nothing prunes it yet. It is
gitignored along with the rest of `.viberevert/`.

**`viberevert end` does more work than it used to.** It hashes every present
tracked regular file to build the candidate set, and again at the coherence
fence. That is the same order of work `viberevert start` already does. If `end`
feels slower on a large repository, this is why.

**`end` refuses rather than capturing incoherent evidence.** If the working tree
changes while the contribution is being captured, `end` fails with
`EndStateChangedDuringCapture` and the session stays active. Re-run it once the
tree is settled. A partially captured contribution would be worse than none,
because everything downstream trusts its digest.

**A second concurrent `end` is refused immediately** with
`ConcurrentOperationError`, before doing any capture work.

**`verify.commands` now executes.** It was parsed and validated but never run in
the beta. As of 0.8.0 a selective rollback apply runs it, from the snapshot taken
at `viberevert start` rather than from live config. If you have entries in
`verify.commands` that you never expected to run, review them before your first
selective apply. See [docs/config.md](docs/config.md) for exactly where they
execute and where they do not.

**`contribution_sha256` is not comparable across operating systems.** A regular
file's executable bit is a real boolean on POSIX and unreportable on Windows,
where the capture records unknown. The same content captured on two platforms
therefore yields different digests. This is deliberate: the artifact records what
it could actually observe. Do not use the digest as a cross-machine content
identity.

### Downgrading

Going back to a pre-0.8.0 version leaves the new files on disk, where the older
code ignores them. The older code will, however, reject a `session.json`
containing the new fields, because these schemas reject unknown fields rather
than ignoring them. If you need to downgrade, do it on a repository whose
sessions were all created by the older version, or remove `.viberevert/` and
start fresh.

---

## Format-version reference

Each persisted artifact carries its own independent schema version, so one
format can evolve without forcing a migration of the others. The current
versions are listed in
[docs/session-format.md](docs/session-format.md#schema-versions).
