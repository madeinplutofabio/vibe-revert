# @viberevert/cli-commands

> Reusable typed command classes and operation functions for the VibeRevert CLI and MCP server.

Hosts the 14 Clipanion `Command` classes (parse CLI options → render human output) and the typed *operation* functions (presentation-free domain operations that mutate session/checkpoint/prompt state). Both the `viberevert` binary CLI and `@viberevert/mcp` server consume this package as their single source of operation logic — keeping CLI behavior and MCP tool behavior unified.

Part of [VibeRevert](https://github.com/madeinplutofabio/vibe-revert) — the safety belt for vibe coding.

**Status:** `v0.7.0-beta` work in progress. Public API may change before v1.0.

## Why this package exists

`@viberevert/cli-commands` was extracted from the `viberevert` CLI binary in milestone G1a to break the cli↔mcp circular-dependency knot that would have formed if `@viberevert/mcp` had to import Command classes (or worse, screen-scrape their stdout) directly from the CLI binary. By hosting the Commands plus a small reusable `runCommandInProcess` Clipanion harness AND a set of typed *operation* functions, this package becomes the single seam through which the MCP server can drive vibe-revert behavior without re-implementing it.

Three backend kinds the MCP server may use (M G1a D99.E):

- **command-harness** — `runCommandInProcess(CommandClass, argv, {cwd})` for Commands whose `--json` output already carries everything the MCP envelope needs (`check`, `report`).
- **typed-operation** — direct import of `startSessionOperation` / `createCheckpointOperation` / `generateFixPromptOperation` for behaviors whose Commands emit only human-readable stdout. Same operation drives both the CLI and the MCP tool — no logic duplication.
- **direct-core** — direct import from `@viberevert/core` (e.g., `loadConfig` for the `get_policy` tool). Only allowed for the narrow carve-out documented in D99.M.6.

## Dependency graph

```text
viberevert (CLI)         ─►  @viberevert/cli-commands
viberevert (CLI)         ─►  @viberevert/mcp
@viberevert/mcp          ─►  @viberevert/cli-commands  (barrel only; no deep imports)
@viberevert/cli-commands ──X  (NEVER imports @viberevert/mcp)
```

No cycles. Architectural-invariants tests enforce these boundaries (M G1a D99.M.15 / D99.M.16 / D99.M.19).

## Operation contract

Every function exported from `src/operations/*.ts` MUST:

- Accept explicit `cwd` — never read `process.cwd()` directly.
- Never write to `process.stdout` / `process.stderr` / `process.exit`.
- Never use `console.*`.
- Never touch Clipanion's `Command` / `BaseContext` APIs (operations are not Commands).
- Return typed results.
- Own no presentation formatting (no `"Session started."` text, no `"ID:"` prefix).
- Throw typed error classes on failure.

Locked by M G1a D99.M.21 + verified by `test/operations/*.test.ts`.

## License

Apache-2.0. See the repository [LICENSE](https://github.com/madeinplutofabio/vibe-revert/blob/main/LICENSE) and [NOTICE](https://github.com/madeinplutofabio/vibe-revert/blob/main/NOTICE).
