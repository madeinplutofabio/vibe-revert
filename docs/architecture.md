# Architecture

VibeRevert is a local-first command-line tool built from a set of
single-purpose TypeScript packages, plus a Model Context Protocol (MCP) server.
VibeRevert's control plane and persisted state run locally against one git
repository. Commands and agents launched through VibeRevert retain their own
network, storage, and process behavior. This page is a map of the pieces and how
a command flows through them; detailed behavior for each surface lives in its own
contract document (see [Further reading](#further-reading)).

## Overview

The CLI binary registers a set of commands. Each command orchestrates a few
domain packages — configuration and sessions, the risk-checking engine, git
snapshotting, and rendering — that each do one thing and depend only on the
shared persisted-format definitions. The MCP server reuses shared typed
operations from `@viberevert/cli-commands`, rather than invoking the `viberevert`
binary.

## Packages

| Package | Role | Layer |
|---|---|---|
| `@viberevert/session-format` | Persisted-artifact schemas, types, derived JSON Schemas, and pure helpers | Foundation |
| `@viberevert/adapters` | Read-only integration contracts and the built-in hook adapters | Foundation |
| `@viberevert/core` | Config loading, framework detection, ids, paths, session lifecycle, policy resolution | Domain |
| `@viberevert/checks` | The risk-classification engine, detector registry, and finding clustering | Domain |
| `@viberevert/git` | The only package that runs git: checkpoint capture, diffs, and restore | Domain |
| `@viberevert/reporters` | Pure renderers for reports, rollback receipts, and fix prompts | Domain |
| `@viberevert/installers` | The non-destructive install/uninstall engine (preview, apply, per-repo lock) | Domain |
| `@viberevert/cli-commands` | The command implementations and typed operations that orchestrate the above | Orchestration |
| `@viberevert/mcp` | The MCP server, its documented tool surface, and append-only audit log | Entry point |
| `viberevert` | The `viberevert` binary that registers and runs the commands | Entry point |

A reserved `@viberevert/policies-basic` package exists but ships no behavior in
this release.

**Dependency direction.** Imports flow one way and form a cycle-free graph. The
foundation packages depend on nothing internal; each domain package depends only
on `@viberevert/session-format` (with `installers` sitting on `adapters`);
`cli-commands` depends on the domain packages; `mcp` depends on `cli-commands`,
`core`, and `session-format`; the binary depends on `cli-commands` and `mcp`.
`adapters` is factored out specifically to keep `installers` and `cli-commands`
acyclic, and `mcp` intentionally does not depend on the binary.

## Execution flows

- **`init`** detects the framework (`core`), writes `.viberevert.yml` from the
  chosen profile, creates the local `.viberevert/` store, and adds it to
  `.gitignore`.
- **Session lifecycle (`start` / `run` / `end`).** `start` captures a
  pre-session checkpoint (`git`), records the resolved evaluation snapshot, and
  writes the active-session lock; `run` evaluates the command guard, starts a
  session, spawns your command as a child process, and ends the session when it
  exits; `end` captures the session's contribution under a lock, records
  post-session git status, and releases the lock. See the
  [run contract](run-contract.md) and [shell contract](shell-contract.md).
- **`check`** resolves the base to compare against, diffs it (`git`), runs the
  checks engine (`checks`), clusters and sorts the findings, renders them
  (`reporters`), persists the report, and sets the exit code — `2` when a finding
  is at or above the block level, `0` otherwise. See [risk taxonomy](risk-taxonomy.md).
- **`rollback`** runs under a lock: it loads the session's checkpoint, runs the
  refusal checks, writes a mandatory emergency checkpoint before any mutation,
  restores the working tree (`git`), and writes a receipt — a dry-run preview by
  default. Supplying any selector routes it to the selective engine instead,
  which resolves the selection against the session's contribution, publishes a
  pre-mutation attempt marker, transplants only the selected change groups, and
  verifies both the selected and the unselected paths on either side of the
  project's own verification commands. Argument validation and rendering sit
  outside the lock; everything that reads rollback state or mutates runs inside
  it. See the [rollback contract](rollback-contract.md) and
  [rollback limitations](rollback-limitations.md).
- **`mcp serve`** binds one repository at boot from the current directory, opens
  an append-only audit log, and serves its tools over stdio. See the
  [MCP contract](mcp-contract.md).

## Trust and process boundaries

- **Local VibeRevert state.** VibeRevert itself performs no network I/O in the
  `init`, `check`, session-recording, or `rollback` control paths. Its files stay
  on your machine — `.viberevert.yml` at the repository root and the
  `.viberevert/` store — while commands and agents it launches may communicate
  externally according to their own behavior.
- **Child processes run unmodified.** `run` and `shell` guard the top-level
  command you pass and spawn it without a shell; commands that a child process
  then spawns are not intercepted (see the [run contract](run-contract.md)).
- **PTY interception is best-effort.** The experimental `shell --pty` mode
  intercepts commands on a best-effort basis (see the [PTY contract](pty-contract.md)).
- **One MCP server serves one repository.** It binds the repo at boot, is
  config-blind at boot, records every tool call in an append-only audit log, and
  accepts no per-call repository target.
- **Rollback is not atomic.** An applied rollback can fail partway through.
  VibeRevert writes an emergency checkpoint before mutation, providing a recovery
  point if application fails partway; recovery may still require manual action
  (see [rollback limitations](rollback-limitations.md)).
- **The native PTY dependency is optional.** `node-pty` is loaded only when
  `--pty` is requested. If it is unavailable, the live-PTY path reports that
  condition without preventing the non-PTY CLI and MCP surfaces from loading
  (see [Compatibility](compatibility.md)).

The full trust model — what VibeRevert defends against and what it explicitly
does not — is in the [threat model](../THREAT_MODEL.md); report vulnerabilities
via [SECURITY.md](../SECURITY.md).

## Further reading

- Getting started and reference: [Getting started](getting-started.md),
  [Commands](commands.md), [Configuration](config.md),
  [Session format](session-format.md), [Risk taxonomy](risk-taxonomy.md).
- Flow contracts: [run](run-contract.md), [shell](shell-contract.md),
  [PTY](pty-contract.md), [rollback](rollback-contract.md),
  [rollback limitations](rollback-limitations.md),
  [prompt-fix](prompt-fix-contract.md), [git hook](hook-contract.md),
  [installers](installers-contract.md), [integrations](integrations.md),
  [MCP](mcp-contract.md).
- Policy and security: [Compatibility](compatibility.md),
  [threat model](../THREAT_MODEL.md), [SECURITY.md](../SECURITY.md).