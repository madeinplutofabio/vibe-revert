# Integrations

Per-integration ship status for the M G1b integration installer milestone.

| Integration | Scope | Status (as of M G1b Step 7) | Notes |
|---|---|---|---|
| Cursor | Project-local `<repo>/.cursor/mcp.json` | shipped (M G1b) | See `docs/installers-contract.md` for per-adapter behavior. |
| Claude Code | Project-local `<repo>/.mcp.json` | shipped (M G1b) | See `docs/installers-contract.md` for per-adapter behavior. |
| GitHub Action workflow template | `<repo>/.github/workflows/viberevert.yml` | shipped (M G1b) | Pinned to exact CLI version; uses `--since` for PR/push diff ranges; `permissions: { contents: read }`; sentinel-replace on re-install. Explicit-only (excluded from `--all`). |
| Husky | `<repo>/.husky/pre-commit` sentinel block | shipped (M G1b) | Refusal-on-detection (M F) flipped to delegation. `--migrate-from-hook-install` orchestrates removal of a prior VibeRevert direct hook. |
| Lefthook | `<repo>/lefthook.yml` sentinel block under `pre-commit.commands` | shipped (M G1b) | Refuses with shape-specific `reasonCode` when the config shape is unsupported. Full YAML merge deferred to M G1b-followup-4. |
| Direct hook | `<repo>/.git/hooks/pre-commit` | shipped (M G1b) | `viberevert install --direct` is records-based. `viberevert hook install` remains the legacy/backward-compatible M F path. Coexistence guard prevents conflict between the two surfaces. |
| Codex | Project-local `<repo>/.codex/config.toml` | deferred -- 90-day stability gate | M G1b Step 0 verify-item 4 found active churn in Codex config / MCP docs, including MCP server config changes. Re-evaluate in **M G1b-followup-3**. |
| Copilot | n/a | not planned | Out of M G1b scope; no installer planned. |
| Windsurf | n/a | not planned | Out of M G1b scope; no installer planned. |
| `--global` (any tool, home-dir) | `~/.cursor/mcp.json` / `~/.claude/settings.json` / `~/.codex/config.toml` | deferred entirely | Runtime-identity problem: a global MCP server entry has no way to bind to a specific repo at request time. Designs explicit repo binding (`viberevert mcp serve --repo <root>` OR per-repo server names) → **M G1b-followup-10**. |

## Scope discipline

- **Project-local default.** All M G1b integrations write to project-scoped paths within the user's repo. No home-directory writes; no `--global` flag.
- **No broad silent writes.** `viberevert install --all` uses each adapter's `intent: "all"` detection path. Cursor, Claude Code, Husky, and Lefthook require adapter-specific on-disk signal; tools without signal print `[skipped: <adapter>: <reason>]`. Direct hook is the safe-hook fallback when no hook manager owns the surface. GitHub Action remains explicit-only.
- **GitHub Action template is explicit-only.** `--all` does NOT include `--github-action` because writing a CI workflow file is a repo-governance change requiring explicit intent.
- **`.viberevert/` transient paths gitignored.** The store (`.viberevert/integrations.json`) should be committed; the lock, journal, and backup directories should be gitignored. The installer engine does not auto-edit `.gitignore`.

## Reference

- M G1b plan section D101.K -- locked adapter set.
- `docs/installers-contract.md` -- per-adapter conflict matrix + full contract (added in M G1b Step 7).
- `docs/hook-contract.md` -- M F hook lifecycle (relevant to husky / lefthook / direct-hook delegation).
- `docs/mcp-contract.md` -- MCP server contract (referenced by the Cursor + Claude integrations).
