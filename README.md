# VibeRevert

> The safety belt for vibe coding.

**Status:** `v0.7.0-beta.0` (first public beta).

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

Works with any Git repo today. MCP support is available for compatible clients; first-class Cursor and Claude Code installers ship in v0.7.1-beta. See [docs/integrations.md](docs/integrations.md) for status.
The MCP server contract (8 tools, JSON-RPC over stdio) is in `docs/mcp-contract.md`.

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
