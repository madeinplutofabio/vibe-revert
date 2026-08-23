# Session format

VibeRevert stores everything about a session locally, under `.viberevert/` in
your repository. This page documents the persisted files, their schema versions,
and which parts are a stability surface you can rely on. These artifacts stay on
your machine; the tools and agents you wrap have their own network and storage
behavior. `viberevert init` adds `.viberevert/` to your `.gitignore`.

## Directory layout

```text
.viberevert/
├── active-session.json                    # the active session, if any
├── sessions/<session-id>/
│   ├── session.json                        # session record
│   ├── before-status.txt                   # git status at start (audit)
│   ├── after-status.txt                    # git status at end (audit)
│   ├── after-status.z                      # git status at end, machine form
│   ├── commands.log                        # one line per guarded command
│   ├── checkpoint/                         # the pre-session checkpoint
│   │   ├── manifest.json
│   │   └── rollback/…                      # patches + tarballs (see below)
│   ├── report.json                         # check report for this session
│   ├── rollback-dry-run-receipt.json
│   └── rollback-receipt.json
├── checkpoints/<checkpoint-id>/            # standalone checkpoints
│   ├── manifest.json
│   └── rollback/…
└── reports/<report-id>/report.json         # ad-hoc (non-session) reports
```

Files are created only when the corresponding operation occurs; an individual
session directory may contain only a subset.

## Persisted formats (the versioned surface)

Five kinds of file are JSON validated by a strict schema in
`@viberevert/session-format` — unknown fields are rejected, not ignored. These
are the schema-validated on-disk formats governed by VibeRevert's format-version
and migration discipline:

| File | Path | Schema |
|---|---|---|
| Active-session lock | `.viberevert/active-session.json` | `ActiveSessionLock` |
| Session record | `.viberevert/sessions/<id>/session.json` | `SessionState` |
| Checkpoint manifest | `…/manifest.json` | `Manifest` |
| Check report | `…/report.json` | `ReportFile` (wraps a `SessionReport`) |
| Rollback receipt | `…/rollback-receipt.json`, `…/rollback-dry-run-receipt.json` | `ReceiptFile` |

Some structures are **nested inside** those files and never written on their
own: a `ReportFile` contains a `SessionReport`, which contains `ChangedFile` and
`CheckResult` entries, each `CheckResult` containing `Evidence`; a `ReceiptFile`
contains `RollbackFileResult` and `RollbackFailure` entries. The rollback receipt
is documented in full by the [rollback contract](rollback-contract.md).

Machine-readable JSON Schema exports are provided from `@viberevert/session-format`
for structural validation and tooling. They do not encode every runtime rule,
including some cross-field constraints and identifier semantics.

## Raw capture files (not schema-versioned)

Rollback-capture and audit files are not JSON artifacts and carry no schema or
version. They are operational capture files rather than VibeRevert JSON formats:
patch and status files use Git output formats, archive files use gzip-compressed
tar, and `commands.log` is JSON Lines.

- `rollback/unstaged.patch`, `rollback/staged.patch` — `git diff` patches.
- `rollback/tracked-dirty.tar.gz`, `rollback/untracked.tar.gz` — gzip-compressed tar archives of captured working-tree content.
- `before-status.txt`, `after-status.txt` — `git status --porcelain=v1` text, for audit only.
- `after-status.z` — `git status --porcelain=v1 -z` bytes, used for the rollback dirty-tree comparison.
- `commands.log` — one JSON object per line, per guarded command.

Internal advisory locks under `.viberevert/.locks/` are an implementation detail,
not a persisted format.

## Schema versions

Each versioned file embeds a `schema_version`. There are **seven independent
version constants**, and they do **not** advance together: a change to one does
not force a bump in the others. They happen to share the value `1.0` today.

| Format axis | Version constant | Current version |
|---|---|---:|
| Session state and active-session lock | `SESSION_STATE_SCHEMA_VERSION` | `1.0` |
| Checkpoint manifest and report body | `SCHEMA_VERSION` | `1.0` |
| Report-file wrapper | `REPORT_FILE_SCHEMA_VERSION` | `1.0` |
| Rollback receipt | `RECEIPT_FILE_SCHEMA_VERSION` | `1.0` |
| Session contribution | `CONTRIBUTION_FILE_SCHEMA_VERSION` | `1.0` |
| Rollback attempt marker | `ROLLBACK_ATTEMPT_SCHEMA_VERSION` | `1.0` |
| Selective rollback receipt | `SELECTIVE_ROLLBACK_RECEIPT_SCHEMA_VERSION` | `1.0` |

The last three axes are **declared, not yet produced**. Their schemas ship in
`@viberevert/session-format` so the formats are defined and reviewable ahead of the
commands that will write them. No VibeRevert command creates those files today,
which is why the directory layout and the file inventory above do not list them.

A `report.json` therefore carries **two** `schema_version` fields: the outer
`ReportFile` (`REPORT_FILE_SCHEMA_VERSION`) and the inner report
(`SCHEMA_VERSION`). The active-session lock is a subset of the session record and
shares `SESSION_STATE_SCHEMA_VERSION`.

Schema versions are independent of the npm package and CLI versions. A new
VibeRevert release does not necessarily change an on-disk format, and a
format-version change is a separate, migration-gated event.

## Stability and compatibility

Stable:

- The **export surface** of `@viberevert/session-format` — its schemas, types,
  and helpers. Internal module layout may change without a major bump as long as
  that surface holds.
- The **version-bump discipline**: while a format is pre-1.0 it may change with
  documented migration notes; after 1.0 a breaking change requires a major
  version bump. Every version change ships with a migration note and updated
  schemas.

Not implied:

- A field existing today is **not** necessarily a permanent field-level
  guarantee. New **optional** fields can be added within an unchanged
  `schema_version` (older files stay valid — the machine-readable end-of-session
  snapshot path was added this way). A breaking change to an existing field is
  what triggers a version bump.
- Because the schemas are strict, a file never silently carries unknown fields;
  reading one with unexpected keys fails loudly rather than ignoring them.

Treat the persisted files as a validated, versioned format with a clear change
discipline — not as a frozen, field-by-field public API.
