# Changelog

All notable changes to VibeRevert will be documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documentation

- Removed stale capability claims about Codex / Copilot / Windsurf
  integrations, wrapper commands (`viberevert run` deferred to M G2),
  and policy packs that are not shipped yet. Affected: root
  `README.md`, `packages/cli/README.md`,
  `packages/installers/README.md`, `packages/adapters/README.md`,
  and `packages/policies-basic/README.md`.
- Added `docs/integrations.md` with the per-adapter ship-status table:
  cursor / claude / direct-hook / husky / lefthook / github-action
  planned for M G1b; codex deferred pending the 90-day stability gate;
  global installs deferred to M G1b-followup-10.
- Updated per-package `Status:` lines to reflect the actual release
  shape: `v0.7.0-beta.0` published, first public release at
  `v0.7.1-beta.0`, or private stub through `v0.7.1-beta`.
- Added `plans/milestone_rp_to_g1b_reconciliation.md` to document why
  the final M G1b scope differs from earlier drafts without rewriting
  the archived M RP plan.

## [0.7.0-beta.0] - 2026-06-22

First public beta. Published to npm as `viberevert@beta` and the
seven supporting `@viberevert/*` packages at version `0.7.0-beta.0`.
See per-feature contract docs under `docs/` for authoritative shape
locks.

### Added

- `viberevert check` / `report` / `prompt-fix` -- risk classification,
  fix-prompt rendering, atomic temp+rename file writes (M B / M C / M E).
- `viberevert start` / `end` / `checkpoint` / `checkpoints` /
  `sessions` -- session + checkpoint lifecycle with ULID identifiers
  and per-session NDJSON audit (M B / M C).
- `viberevert rollback <session>` (dry-run by default, `--apply` to
  execute) -- restores tracked + untracked file content and git index
  from a session's pre-session snapshot; emits a structured rollback
  receipt; idempotent re-apply refusal (M D). See
  `docs/rollback-contract.md`.
- `viberevert hook install` / `hook uninstall` (POSIX + Windows
  semantics; `--force` backup; `--restore` round-trip) -- managed
  `pre-commit` hook that runs `viberevert check --staged` (M F). See
  `docs/hook-contract.md`.
- `viberevert mcp serve` -- Model Context Protocol server over stdio
  exposing 8 tools (check_repo, explain_diff, classify_risk,
  list_risky_files, get_policy, start_session, create_checkpoint,
  generate_fix_prompt). Reserved-but-hidden: rollback,
  request_human_approval (M G1a). See `docs/mcp-contract.md`.
- `viberevert init` / `doctor` / `--version` -- workspace
  initialization, environment diagnostics, version reporting (M B).

### Security

- No raw tool arguments in the MCP audit log (D99.J never-log-args).
- R31 reflection locks: arbitrary unknown tool names never echoed
  into responses or audit (`<unknown>` sentinel).
- MCP library never writes to `process.stdout` / `process.stderr` /
  `process.exit` (D99.M.14). CLI wrapper owns process exit + human
  stderr; MCP library returns/rejects.
- Cold-start lock (D99.M.12): MCP package (SDK + audit writer + Zod
  schemas + tool registry) loaded only when `viberevert mcp serve`
  is invoked; non-mcp commands pay zero MCP import cost.
- Audit `tool_name` sanitization: printable ASCII only, capped at
  64 chars (prevents NDJSON injection from malicious client names).

### Documentation

- `docs/rollback-contract.md` -- rollback receipt shape, dry-run vs
  apply semantics, scope-of-restore boundaries.
- `docs/prompt-fix-contract.md` -- fix-prompt rendering contract,
  D81 byte-identity discipline, target resolution.
- `docs/hook-contract.md` -- POSIX hook script template, managed-by
  marker, backup/restore semantics, Windows chmod no-op.
- `docs/mcp-contract.md` -- MCP server contract: 8 tools, envelope,
  4-category dispatcher matrix, 5 audit shapes, output caps,
  timeout policy, library discipline, 22 architectural invariants
  summary.
- `docs/release-process.md` -- local smoke-test workflow, packed-CLI
  validation against scratch repos.

### Architecture

- 12-package pnpm monorepo with explicit cross-package boundary
  invariants (22 D99.M architectural invariants for MCP boundaries;
  D98.M for hooks; D90 for prompt-fix; D77 for rollback).
- Node >=22, TypeScript 5.9, biome lint/format, vitest, clipanion 3.x.
- ASCII-only at byte level across MCP source (D99.M.13) and per-tool
  hook scripts (D98.M.4).

[Unreleased]: https://github.com/madeinplutofabio/vibe-revert/compare/v0.7.0-beta.0...HEAD
[0.7.0-beta.0]: https://github.com/madeinplutofabio/vibe-revert/releases/tag/v0.7.0-beta.0
