<p align="center">
  <img
    src="docs/assets/brand/viberevert-mark.png"
    alt="VibeRevert logo"
    width="120"
  >
</p>

<h1 align="center">VibeRevert</h1>

<p align="center">
  <strong>AI broke your project? Undo the session, not your week.</strong>
</p>

**Status:** `v0.7.1-beta.1` (beta).

VibeRevert records an AI coding session, flags risky changes, and can restore your project files to exactly how they were before it started, including work you hadn't committed.

<!-- H12.5: canonical terminal recording / screenshot of a real session (record → check flags a risky change → rollback restores the files) slots in here, above the fold. -->

## Quickstart

Works inside a Git repository and requires Node.js 22+. VibeRevert itself keeps its records on your machine and requires no VibeRevert account or hosted service.

Install it:

```bash
npm install -g viberevert@beta
```

Set up your project once, then wrap each AI coding session:

```bash
viberevert init                # one-time setup in your project
viberevert run <your-agent>    # records the session and saves your files' starting state
viberevert check               # see what changed and what looks risky
viberevert rollback <session>  # preview putting your files back; add --apply to restore
```

Protect my project before the next AI session.

## What it does

Around each AI coding session, VibeRevert:

- **Checkpoints your project first** — working tree, staged changes, and untracked files, including work you haven't committed.
- **Records the session** and the project files that changed while it was running.
- **Flags risky edits** — changes touching auth, payments, databases, secrets, dependencies, or infrastructure ([risk taxonomy](docs/risk-taxonomy.md)).
- **Writes an agent-ready fix prompt** from those findings, to paste into your next iteration.
- **Restores your files** to the checkpoint when you need it.

It **warns** you; it does not silently block your work. An optional pre-commit hook can reject a commit that exceeds your configured risk threshold. It is opt-in, tunable, and bypassable like other local Git hooks.

## What it restores — and what it doesn't

`viberevert rollback` restores your **local project files** — tracked, staged, and untracked, including uncommitted work — to how they were when the session started. It previews by default; `--apply` writes the change, and every apply first saves an emergency checkpoint of the current state.

It does **not** reverse effects outside your project files. Deployments, database writes, third-party API calls, payments, and sent emails require their own recovery or compensation steps. Rollback is state-based rather than atomic, and it is a safety net around AI sessions, not a replacement for tests or code review. Read [what rollback can and can't restore](docs/rollback-limitations.md) before you rely on it.

## Records stay local

VibeRevert stores its own records in a `.viberevert/` directory inside your repository. It requires no VibeRevert account or hosted service. Your AI agent is separate software and may still communicate with its own provider.

## Records and reports

Each session leaves a local record you can inspect again. `viberevert check` shows the changed files, risk findings, and an agent-ready fix prompt. `viberevert rollback <session>` previews the planned restoration before it writes anything.

See the [session format](docs/session-format.md) for the underlying record structure.

## Wire it into your tools

`viberevert install` adds managed VibeRevert entries while preserving unrelated user configuration:

```bash
viberevert install --cursor          # merge MCP server into .cursor/mcp.json
viberevert install --claude          # merge MCP server into .mcp.json
viberevert install --direct          # write .git/hooks/pre-commit directly
viberevert install --husky           # add a managed block to .husky/pre-commit
viberevert install --lefthook        # add a managed block to lefthook.yml
viberevert install --github-action   # write a pinned CI workflow (explicit-only)
viberevert install --all             # the five non-CI adapters above
```

`viberevert uninstall` mirrors the same flags and removes only the entries managed by VibeRevert. Successful installs are recorded in `.viberevert/integrations.json`; reinstall and uninstall check for configuration drift and use a per-repository lock and recovery journal.

See the [installers contract](docs/installers-contract.md) and [integration status](docs/integrations.md).

## Experimental terminal bridge

`viberevert shell --pty` is an experimental, opt-in bridge for interactive Bash sessions. It checks commands at the prompt on a best-effort basis. It is a prompt-level safety net, not a sandbox or complete command interceptor.

The support matrix marks PTY as exercised on Linux, capability-gated on macOS, and unavailable on Windows. See the [shell `--pty` notes](packages/cli/README.md#shell---pty-experimental) and the [PTY contract](docs/pty-contract.md).

## Platforms

The standard `init` → `run` → `check` → `rollback` workflow runs on Linux, macOS, and Windows with Node.js 22+. See [compatibility and support levels](docs/compatibility.md).

## Learn more

- [Getting started](docs/getting-started.md) · [Commands](docs/commands.md) · [Configuration](docs/config.md) · [Session format](docs/session-format.md)
- [Architecture](docs/architecture.md) · [Risk taxonomy](docs/risk-taxonomy.md) · [Rollback limitations](docs/rollback-limitations.md) · [Positioning](docs/positioning.md)
- [Security](SECURITY.md) · [Threat model](THREAT_MODEL.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
