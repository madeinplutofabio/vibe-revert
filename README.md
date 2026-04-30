# VibeRevert

> The safety belt for vibe coding.

**Status:** `v0.7.0-beta` work in progress. Not yet released.

VibeRevert makes AI coding sessions **visible, reversible, and safer**.

A VibeRevert session is a local, versioned artifact that records the
pre-session restore point, post-session changes, risk findings, generated
fix prompt, and rollback metadata.

## Install

Available after the first public beta ships:

```bash
npx viberevert init
viberevert run claude
viberevert check
viberevert prompt-fix
viberevert rollback
```

Works with Claude Code, Codex, Cursor, Copilot, Windsurf, and any Git repo.

## What it does

- Creates a checkpoint before AI coding sessions.
- Records what the agent changed.
- Flags risky edits involving auth, payments, databases, secrets, dependencies, and infrastructure.
- Guards dangerous commands launched through its wrapper.
- Generates an AI-readable fix prompt for the next iteration.
- Provides a rollback path for local repository state.

## What it does not do

- Prevent all AI coding mistakes.
- Sandbox every tool.
- Undo external side effects such as production database changes, deployments, third-party API calls, or sent emails.
- Replace tests or code review.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
