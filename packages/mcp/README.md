# @viberevert/mcp

> Local Model Context Protocol server for VibeRevert.

Exposes VibeRevert's read-only and local-write tools to AI coding agents over MCP stdio. Boots via the `viberevert mcp serve` CLI command; the server is config-blind (no `.viberevert.yml` required) and binds to the repository it was launched in.

Part of [VibeRevert](https://github.com/madeinplutofabio/vibe-revert) — the safety belt for vibe coding.

**Status:** `v0.7.0-beta` work in progress. Public API may change before v1.0.

## Run it

```sh
viberevert mcp serve
```

Boots a Model Context Protocol server over stdio. The server speaks JSON-RPC 2.0 over stdin/stdout. Stdin EOF triggers graceful shutdown; any in-flight tool call completes before the process exits.

Programmatic consumers can boot the same server via the package barrel:

```ts
import { startServer } from "@viberevert/mcp";

await startServer({ cwd: process.cwd() });
```

## Tools

Eight tools are exposed (five read-only, three local-write):

**Read-only:**

- `check_repo` — run `viberevert check` against the bound repository and return the structured report (full body if ≤1 MiB, otherwise a summary).
- `explain_diff` — render a human-readable Markdown explanation of a session's report.
- `classify_risk` — return the highest-severity finding bucket for a session.
- `list_risky_files` — enumerate the files with non-low findings (max 500).
- `get_policy` — return the resolved configuration (defaults if `.viberevert.yml` is absent).

**Local-write:**

- `start_session` — create a new VibeRevert session in the bound repository.
- `create_checkpoint` — capture a checkpoint inside the active session.
- `generate_fix_prompt` — produce the fix-prompt text for a report and persist it to `fix-prompt.txt`.

No tool accepts a `cwd`-like parameter — all operations target the repository the server was booted in.

## Reserved names

Two tool names are reserved and intentionally NOT exposed in `tools/list`:

- `rollback` — deferred to a future milestone with real human-in-the-loop semantics.
- `request_human_approval` — same reservation policy.

Any call to a reserved name returns a `Tool not found` envelope identical to the response for any other unknown name (no leak of "exists but blocked"). The denial response and audit record NEVER echo an arbitrary tool name back.

## Audit

Every tool call (and every denial) is appended as a single NDJSON record to `<repo>/.viberevert/mcp-audit.log`. Records carry the tool name, timestamp, ok/exit-code, and duration only — **raw arguments are NEVER logged**.

## Out of scope (v0.7.0-beta)

- HTTP / SSE transport. Stdio only.
- Per-tool `cwd` (confused-deputy risk; server binds to its boot directory).
- Execution / write tools beyond the three local-write tools above. No code execution, no remote calls.
- Cross-repository operation. One server, one repository.

## Reference

See [`docs/mcp-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/mcp-contract.md) for the canonical contract: full tool input/output shapes, dispatcher matrix, audit record shapes, output caps, timeout policy, and architectural invariants.

## License

Apache-2.0. See the repository [LICENSE](https://github.com/madeinplutofabio/vibe-revert/blob/main/LICENSE) and [NOTICE](https://github.com/madeinplutofabio/vibe-revert/blob/main/NOTICE).
