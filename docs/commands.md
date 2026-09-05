# Commands

Every VibeRevert command is invoked as `viberevert <command> [options]`. This
page is the complete command reference and is verified against the CLI's own
definitions by an automated coverage test.

## Getting help

- `viberevert --help` or `viberevert -h` — list every command.
- `viberevert <command> --help` — detailed help for one command.
- `viberevert` with no arguments prints the same general help (exit code 0).

## Setup

### `viberevert init`

Initialize a VibeRevert config and scaffold in this repo.

**Options**

- `--profile <name>` — force a profile: built-in `generic`, `laravel`, `lovable`, `nextjs`, `python`, `rails`; any other name produces a generic-shaped config _(default: auto-detected)_.
- `--force` — overwrite an existing `.viberevert.yml` _(default: off)_.

### `viberevert doctor`

Report VibeRevert environment status (node, pnpm, git, repo, config).

## Sessions

### `viberevert start`

Begin a new session, capturing the pre-session checkpoint.

**Options**

- `--task <text>` — optional description of what this session will do.

### `viberevert run`

Run a command inside a VibeRevert session (guarded wrapper).

**Arguments**

- `<arg> ...` — the command and its arguments to run (required).

**Options**

- `--task <text>` — optional session description.

### `viberevert shell`

Open a guarded command loop inside a VibeRevert session.

**Options**

- `--task <text>` — optional session description.
- `--pty` — **experimental**: transparent Bash PTY with best-effort, prompt-level command interception; nested processes may bypass it _(default: off)_.

### `viberevert end`

End the active session, capturing post-session git status.

### `viberevert sessions`

List sessions, newest first; the active session is shown with status `active`.

**Options**

- `--json` — emit machine-readable JSON to stdout.

## Checkpoints

### `viberevert checkpoint`

Create a standalone checkpoint of the current working tree.

**Options**

- `--name <text>` — human-readable label for this checkpoint.

**Behavior and constraints**

- A checkpoint name that already exists in the repo is rejected.

### `viberevert checkpoints`

List checkpoints, newest first.

**Options**

- `--json` — emit machine-readable JSON to stdout.

## Checking changes

### `viberevert check`

Run risk checks against changes since a base (checkpoint, session, or git ref).

**Options**

- `--since <base>` — base to check against: checkpoint id (`cp_X`), checkpoint name, session id (`sess_X`), or a git ref.
- `--staged` — scope the diff to staged changes only _(default: off)_.
- `--threshold <level>` — output filter: only show findings at or above `low|medium|high|critical`.
- `--task <text>` — override the task string.
- `--json` — emit the report as JSON to stdout _(default: human-readable)_.

**Behavior and constraints**

- `--threshold` filters displayed findings only; it does **not** affect the exit code.

### `viberevert report`

Render a previously-captured check report.

**Options**

- `--session <id>` — render the report for a session.
- `--report <path>` — render a specific report file.
- `--threshold <level>` — output filter for displayed findings.
- `--json` — render as JSON.
- `--markdown` — render as Markdown.

**Behavior and constraints**

- `--session` and `--report` select the source and are mutually exclusive; `--json` and `--markdown` select the format and are mutually exclusive.
- `--threshold` filters the rendered view only; it does not mutate the persisted report.

### `viberevert prompt-fix`

Render a deterministic fix-prompt from a persisted risk report. The rendered
prompt is byte-identical between stdout and the persisted `fix-prompt.txt`,
begins with a fixed prompt-injection-defense preamble, and renders
repository-controlled fields (titles, messages, ids) in block form so they
cannot inject prompt-section headers.

**Options**

- `--session <id>` — source the report from a session.
- `--report <path>` — source a specific report file.

**Behavior and constraints**

- `--session` and `--report` are mutually exclusive.

## Rollback

### `viberevert rollback`

Restore a session's pre-session captured state, in whole or in part (dry-run by
default). See the [rollback contract](rollback-contract.md) for current
guarantees and limitations.

**Arguments**

- `<session>` — the session id to roll back (required).

**Options**

- `--only` — restore only change groups matching this path glob; repeatable (union).
- `--except` — exclude change groups matching this path glob; repeatable (union), subtracted last.
- `--finding` — restore the change groups a finding applies to; repeatable (union).
- `--risk` — restore change groups at or above this risk level (`low`, `medium`, `high`, `critical`).
- `--apply` — actually apply the rollback (mutates the working tree); omitted, it is a dry-run _(default: dry-run)_.
- `--force` — bypass a subset of pre-rollback safety checks; requires `--apply` _(default: off)_.
- `--json` — render the result as JSON.
- `--markdown` — render the result as Markdown.

**Behavior and constraints**

- `--force` bypasses only the HEAD-mismatch, un-ended-session, and dirty-working-tree checks. It never bypasses the active-session or already-applied guards.
- `--json` and `--markdown` are mutually exclusive.
- With no selector, this restores the whole session exactly as it always has. Supplying any selector, including `--except` on its own, restores only the change groups it resolves to and leaves every other managed path untouched.
- `--only` and `--except` match a renamed file through its whole alias set, so `--only 'payments/**'` still matches a file renamed out of `payments/`.
- `--risk` is an at-or-above threshold, so `--risk high` covers high and critical. A change group no finding touches has no risk and is not selected at any threshold.
- Different positive selector families intersect: `--only 'payments/**' --risk critical` means critical changes inside `payments/`, not payments plus unrelated critical files.
- Exclusion is group-atomic: excluding any path in a rename group excludes the whole group.
- `--finding` takes full finding ids as printed by `viberevert check --since <session> --json`; short prefixes are not accepted yet.
- Selective rollback requires the session's durable contribution. Sessions ended before 0.8.0 do not have one, and it refuses rather than guessing.

## Git hook

### `viberevert hook install`

Install the viberevert pre-commit hook into `.git/hooks/`.

**Options**

- `--force` — back up an existing non-VibeRevert pre-commit hook before installing _(default: off)_.

**Behavior and constraints**

- If a non-VibeRevert `pre-commit` hook already exists, installation refuses unless `--force` is given, which renames the existing hook to a `pre-commit.viberevert-backup-<UTC>` file first.

### `viberevert hook uninstall`

Remove the viberevert pre-commit hook from `.git/hooks/`.

**Options**

- `--restore` — restore the most recent `pre-commit.viberevert-backup-<UTC>` file _(default: off)_.

## Integrations

### `viberevert install`

Install VibeRevert integrations for one adapter or the safe default set.

**Options**

- `--cursor` — install the Cursor integration.
- `--direct` — install the direct git-hook integration.
- `--husky` — install the Husky integration.
- `--lefthook` — install the Lefthook integration.
- `--claude` — install the Claude Code integration.
- `--github-action` — install the GitHub Action integration.
- `--all` — install the safe default set.
- `--dry-run` — show what would change without writing.
- `--force-reinstall` — reinstall even if already present.
- `--migrate-from-hook-install` — migrate a legacy `hook install` setup (requires `--husky`).

**Behavior and constraints**

- Exactly one selector is required — a single adapter flag or `--all`; combining them, or passing none, is rejected.
- `--all` installs `cursor`, `direct`, `husky`, `lefthook`, and `claude`. The GitHub Action is excluded from `--all` and must be selected explicitly with `--github-action`.

### `viberevert uninstall`

Uninstall VibeRevert integrations for one adapter or the safe default set.

**Options**

- `--cursor` — uninstall the Cursor integration.
- `--direct` — uninstall the direct git-hook integration.
- `--husky` — uninstall the Husky integration.
- `--lefthook` — uninstall the Lefthook integration.
- `--claude` — uninstall the Claude Code integration.
- `--github-action` — uninstall the GitHub Action integration.
- `--all` — uninstall the safe default set.
- `--force` — proceed despite non-matching or modified integration records.

**Behavior and constraints**

- Exactly one selector is required — a single adapter flag or `--all`; combining them, or passing none, is rejected.
- `--all` targets the same set as installation (`cursor`, `direct`, `husky`, `lefthook`, `claude`); the GitHub Action is excluded.

## MCP

### `viberevert mcp`

Model Context Protocol server. This one command has two invocations with
different behaviors.

**Alternate invocations**

- `viberevert mcp serve` — boot the MCP server over stdio.

**Behavior and constraints**

- `viberevert mcp` (without `serve`) prints this help and exits 0, by design.
- `viberevert mcp serve` binds at boot to the repo root discovered from the current working directory, and runs until it is signalled to stop.

## Version

### `viberevert version`

Print the VibeRevert CLI version.

**Alternate invocations**

- `viberevert --version`
- `viberevert -v`
