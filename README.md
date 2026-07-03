# VibeRevert

> The safety belt for vibe coding.

**Status:** `v0.7.1-beta.1` (beta).

VibeRevert makes AI coding sessions **visible, reversible, and safer**.

A VibeRevert session is a local, versioned artifact that records the
pre-session restore point, post-session changes, risk findings, generated
fix prompt, and rollback metadata.

## Install

```bash
npm install -g viberevert@beta
viberevert --version
viberevert doctor
viberevert init --profile generic
viberevert mcp serve
```

Works with any Git repo today. MCP support is available for compatible clients. See [docs/integrations.md](docs/integrations.md) for integration status.
The MCP server contract (8 tools, JSON-RPC over stdio) is in `docs/mcp-contract.md`.

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

- Prevent all AI coding mistakes.
- Sandbox every tool.
- Undo external side effects such as production database changes, deployments, third-party API calls, or sent emails.
- Replace tests or code review.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
