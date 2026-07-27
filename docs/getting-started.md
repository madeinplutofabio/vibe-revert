# Getting started

VibeRevert records an AI coding session, checks the resulting changes for risk,
and captures the pre-session working-tree state for supported rollback. This
guide is the shortest path from install to your first checked session.

## Requirements

- Your project is a **git repository** (run `git init` first if it isn't).
- **Node.js 22 or newer.**

VibeRevert stores its session data locally and does not require a VibeRevert
account or hosted service.

## Install VibeRevert

```bash
npm install -g viberevert@beta
```

Confirm it's on your PATH:

```bash
viberevert --version
```

## Initialize your project

From your repository root:

```bash
viberevert init
```

This writes `.viberevert.yml` (your config) at the repo root, creates a local
`.viberevert/` directory for sessions, checkpoints, and reports, and adds
`.viberevert/` to your `.gitignore`. It auto-detects your framework and picks a
matching profile, falling back to a generic one; choose explicitly with
`viberevert init --profile generic`. If `.viberevert.yml` already exists, `init`
refuses unless you pass `--force`.

Check your environment any time:

```bash
viberevert doctor
```

## Review the generated configuration

Open `.viberevert.yml`. By default every risk check is on and `check` blocks
only on `critical` findings — you usually don't need to change anything to
start. Every key and its default is documented in [Configuration](config.md).

## Run your first guarded command

Wrap your AI coding agent with `viberevert run`. It starts a session, captures a
pre-session checkpoint (including uncommitted work), runs your command, then ends
the session and records the result — all automatically.

```bash
viberevert run claude
```

Replace `claude` with the command you normally use to launch your coding agent.
The wrapped command can be anything, not only an agent — a test run, a build, or
a script:

```bash
viberevert run npm test --watch
```

When the command finishes, `run` prints the exact next step, including the
session id.

## How the session ends

`viberevert run` ends the session for you when your command exits: it records
your repository's post-session git status and releases the session so it can be
checked or rolled back later. You only run `viberevert end` yourself if you
started a session manually with `viberevert start` (see [Next steps](#next-steps)).

## Check the changes

Run the command `run` printed — it checks everything that changed during the
session against your risk rules:

```bash
viberevert check --since sess_01J9EXAMPLEID
```

`check` exits `0` when nothing is at or above your block level (default
`critical`) and `2` when something is, so you can gate a script or commit hook on
it. (`--threshold` changes what is displayed, never the exit code.)

## Review the result

`check` writes a report to `.viberevert/sessions/<session-id>/report.json` and
prints a summary. Re-render it any time:

```bash
viberevert report --session sess_01J9EXAMPLEID
```

See [Commands](commands.md) for report formatting options.

## Next steps

- **Roll back a session.** If a session went wrong, `viberevert rollback <session>`
  previews a rollback toward the captured pre-session state. It is a dry-run until
  you add `--apply`; what it can and cannot restore is described in the
  [rollback contract](rollback-contract.md).
- **Guarded interactive shell.** `viberevert shell` opens a command loop inside a
  session (`--pty` is experimental).
- **Run your agent outside VibeRevert.** Use `viberevert start` before your agent
  works and `viberevert end` after, then `check`.
- **Install integrations or a git hook.** `viberevert install` can configure
  supported integrations including Cursor, Husky, Lefthook, Claude Code, GitHub
  Actions, and the direct git-hook adapter.
- **Full reference.** [Commands](commands.md) and [Configuration](config.md).
