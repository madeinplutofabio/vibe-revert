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

## Install integrations

`viberevert install` wires VibeRevert into your tools without overwriting user configuration:

```bash
viberevert install --cursor          # merge MCP server into .cursor/mcp.json
viberevert install --claude          # merge MCP server into .mcp.json
viberevert install --direct          # write .git/hooks/pre-commit directly
viberevert install --husky           # add a managed block to .husky/pre-commit
viberevert install --lefthook        # add a managed block to lefthook.yml
viberevert install --github-action   # write a pinned CI workflow (explicit-only)
viberevert install --all             # the five safe adapters above (no CI workflow)
```

`viberevert uninstall` mirrors the same flags and removes only what VibeRevert wrote. Every install is recorded in repo-local `.viberevert/integrations.json`, drift-checked on reinstall/uninstall, and applied under a per-repo lock with a recovery journal. See [docs/installers-contract.md](docs/installers-contract.md) for the full contract and [docs/integrations.md](docs/integrations.md) for per-adapter status.

## What it does

- Creates a checkpoint before AI coding sessions.
- Records what the agent changed.
- Flags risky edits involving auth, payments, databases, secrets, dependencies, and infrastructure.
- Generates an AI-readable fix prompt for the next iteration.
- Provides a rollback path for local repository state.

## What it does not do

- It does not prevent every AI coding mistake.
- It does not sandbox tools.
- It does not undo external effects such as deployments, database writes, third-party API calls, payments, or sent emails.
- Replace tests or code review.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
