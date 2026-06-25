# Integrations

Per-integration ship status. Updated as M G1b feature work lands (Step 5 + Step 7).

| Integration | Scope | Status (as of M G1b Step 0b, 2026-06-25) | Notes |
|---|---|---|---|
| Cursor | Project-local `<repo>/.cursor/mcp.json` | planned (M G1b) | Confirmed against Cursor MCP docs in M G1b Step 0 verify-item 5. |
| Claude Code | Project-local `<repo>/.mcp.json` | planned (M G1b) | Confirmed against Anthropic Claude Code docs in M G1b Step 0 verify-item 6. `claude mcp add-json` defaults to project scope. |
| GitHub Action workflow template | `<repo>/.github/workflows/viberevert.yml` | planned (M G1b) | Pinned to exact CLI version; uses `--since` for PR/push diff ranges; `permissions: { contents: read }`; sentinel-replace on re-install. |
| Husky | `<repo>/.husky/pre-commit` sentinel block | planned (M G1b) | Refusal-on-detection (M F) flips to delegation. |
| Lefthook | `<repo>/lefthook.yml` sentinel block under `pre-commit.commands` | planned (M G1b) | Refuses with `manualSnippet` if `pre-commit.commands:` key absent. Full YAML merge deferred to M G1b-followup-4. |
| Direct hook | `<repo>/.git/hooks/pre-commit` | planned (M G1b) | Thin wrapper around M F's existing direct-hook logic; recorded in `.viberevert/integrations.json` for round-trip uninstall. M F's `viberevert hook install` stays for backward compat. |
| Codex | Project-local `<repo>/.codex/config.toml` | deferred -- 90-day stability gate | M G1b Step 0 verify-item 4 found active churn in Codex config / MCP docs in the last 90 days, including MCP server config changes. Re-evaluate in **M G1b-followup-3**. |
| Copilot | n/a | not planned | Out of M G1b scope; no installer planned. |
| Windsurf | n/a | not planned | Out of M G1b scope; no installer planned. |
| `--global` (any tool, home-dir) | `~/.cursor/mcp.json` / `~/.claude/settings.json` / `~/.codex/config.toml` | deferred entirely | Runtime-identity problem: a global MCP server entry has no way to bind to a specific repo at request time. Designs explicit repo binding (`viberevert mcp serve --repo <root>` OR per-repo server names) → **M G1b-followup-10**. |

## Scope discipline

- **Project-local default.** All M G1b integrations write to project-scoped paths within the user's repo. No home-directory writes; no `--global` flag.
- **No silent writes.** `viberevert install --all` honors `intent: "all"`: an adapter is only installed when on-disk signal exists (existing `.cursor/`, `.mcp.json`, etc.). Tools without signal print `[skipped: <adapter>: <reason>]` rather than silently creating config files.
- **GitHub Action template is explicit-only.** `--all` does NOT include `--github-action` because writing a CI workflow file is a repo-governance change requiring explicit intent.
- **`.viberevert/` is gitignored.** The installer warns if `.viberevert/` is not in `.gitignore` (but never auto-edits the file).

## Reference

- M G1b plan section D101.K -- locked adapter set.
- `docs/installers-contract.md` -- per-adapter conflict matrix + full schema (added in M G1b Step 7).
- `docs/hook-contract.md` -- M F hook lifecycle (relevant to husky / lefthook / direct-hook delegation).
- `docs/mcp-contract.md` -- MCP server contract (referenced by the Cursor + Claude integrations).
