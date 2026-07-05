# viberevert

> The VibeRevert CLI.

The user-facing command-line tool. Provides `init`, `checkpoint`, `run`, `check`, `report`, `prompt-fix`, `rollback`, `hook install`, `hook uninstall`, `install`, `uninstall`, and `mcp serve`.

Part of [VibeRevert](https://github.com/madeinplutofabio/vibe-revert) — the safety belt for vibe coding.

**Status:** `v0.7.1-beta.1` published; M G2 in progress (unreleased). Public API may change before v1.0.

## Run

`viberevert run <command> [args...]` runs a single command inside a VibeRevert session: it takes a checkpoint, starts a session, spawns the command with `stdio: "inherit"` (no shell, no PTY), ends the session when the command exits, and prints a two-line summary pointing you at `viberevert check --since <session>`. Use `--task "..."` to label the session.

It is deliberately boring -- not a shell, not a terminal emulator, not an agent runtime. `shell: false` is locked, so there is no shell interpretation or injection surface; guarding applies to the top-level invocation only (commands the wrapped program runs internally are never intercepted); and sessions capture FILE changes, not terminal output.

`commands.guard` and `commands.require_confirm` in `.viberevert.yml` gate the top-level command: a guarded match refuses (exit 2) before any session is created; a confirm-required match prompts for the exact phrase `run anyway` on a TTY (and refuses on a non-TTY). Guard wins when both match. The framework init profiles ship live, framework-tailored defaults; the generic profile ships a commented example. These rules take effect only under `run`.

The child's exit code is propagated verbatim (127 for not-found, 126 for not-executable, 128+N for POSIX signal death). All wrapper text goes to stderr; the child owns stdout. Each run appends one JSONL audit line to the session's `commands.log` -- recorded verbatim, with no secret redaction, so do not pass secrets as command-line arguments.

See [`docs/run-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/run-contract.md) for the full contract: argument-boundary rules, guard-matching semantics with worked examples, the exit-code table, confirmation flow, stderr stream lock, signal/cleanup story, Windows `.bat`/`.cmd` note, and the commands.log privacy boundary (D102.A-J).

## Rollback

`viberevert rollback <session-id>` restores the working tree, index, and untracked files to the state captured at the start of the named session.

Default is dry-run: it produces a structured receipt describing what `--apply` would do, without mutating the repo. Pass `--apply` to actually restore. `--force` only bypasses the force-overridable dirty-tree safety checks documented in the contract. Receipts are persisted at `.viberevert/sessions/<sess>/rollback-receipt.json` for apply and `.viberevert/sessions/<sess>/rollback-dry-run-receipt.json` for dry-run; render via `--json`, `--markdown`, or default terminal output.

Every `--apply` auto-creates an emergency pre-rollback checkpoint of the current state before restore, and records its id in the receipt as `pre_rollback_checkpoint_id`.

Scope: filesystem + git state only. Does NOT restore database schemas, deployed artifacts, package-registry publishes, external API state, or any other process-side effects.

See [`docs/rollback-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/rollback-contract.md) for the full contract: refusal-order policy, `--force` override table, receipt schema, and recovery path via the emergency checkpoint.

## Prompt-fix

`viberevert prompt-fix` loads the persisted `ReportFile` produced by `viberevert check` and renders a deterministic, template-based prompt you paste into your coding agent. By default it resolves the active session's report if present, else the latest report across both session-bound and ad-hoc stores; pass `--session <sess-id>` or `--report <rpt-id>` to load an explicit source.

Output is text-only and goes to two sinks byte-identically: stdout AND a sibling `fix-prompt.txt` written next to the source report (`.viberevert/sessions/<sess>/fix-prompt.txt` for session-bound, `.viberevert/reports/<rpt>/fix-prompt.txt` for ad-hoc). The single render call drives both sinks; the file is written first via atomic temp+rename, so a failed persist leaves stdout empty and exit 1 — never the "I see a prompt but the command failed" bad state.

The prompt template is injection-defended (three-paragraph preamble framing report contents as data, never instructions), normalized (dynamic fields rendered block-form so a finding message starting with `## ` can never become a section header), and capped at 20 highest-risk findings with an explicit omitted-count line on truncation. Findings sort critical > high > medium > low. Empty-findings reports refuse with exit 1 AND remove any stale sibling `fix-prompt.txt` (drift-guarded read-read-compare).

Out of scope in v0.7.0: no LLM API calls (`--llm` is a hidden reserved seam that exits 1), no repository source-file reads (renderer trusts the M C redactor's already-redacted evidence), no `--json` / `--markdown` flags, no `FixPromptFileSchema` sidecar. `fix-prompt.txt` is the v0.7.0 compatibility contract; structured wrappers are deferred until a real consumer (MCP `generate_fix_prompt`) needs them.

See [`docs/prompt-fix-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/prompt-fix-contract.md) for the full contract: refusal table, template section details, dynamic-field normalization rules, drift guard, byte-identity write order, and architectural invariants (D90.1-8).

## Hook install / uninstall

`viberevert hook install` writes a deterministic POSIX `#!/bin/sh` pre-commit hook to `.git/hooks/pre-commit` that runs `viberevert check --staged` on every commit. The hook respects your `.viberevert.yml` `risk.block_on` threshold (default: `critical`); on exit 2 it prints a `viberevert prompt-fix` tip on stderr and translates to git-hook exit 1 so blocked commits abort uniformly. Use `git commit --no-verify` for a single-commit bypass; vibe-revert documents it but does not hide it.

Refuses cleanly on husky / lefthook detection (those ecosystems own their own hook lifecycle — invoke `viberevert check --staged` from your manager's pre-commit instead), on git worktree / submodule layouts (`.git`-as-pointer-file is not yet supported), on shared-hooks-directory setups (`.git/hooks` as symlink), and on malformed `package.json`. `--force` overrides ONLY the existing-non-viberevert-hook case (backing it up to `.git/hooks/pre-commit.viberevert-backup-<UTC>`); it does NOT override hook-manager / layout / malformed-JSON refusals — those are absolute.

`viberevert hook uninstall` removes the viberevert-managed hook (identified by an exact line-2 marker check with CRLF tolerance) and refuses to touch hooks it did not write. No `--force` flag: refusing to remove unknown hooks IS the safety belt. With `--restore`, it renames the most recent `pre-commit.viberevert-backup-<UTC>` file back to `.git/hooks/pre-commit` (validate-before-mutate per D98.P: the managed hook is NEVER deleted before backup existence is proven; metadata-fingerprint guard — dev + ino + size + mtimeMs + ctimeMs — catches in-place modification between the first and final stat). The safety posture is best-effort validate-before-mutate, not a cross-process lock.

Re-installing an existing managed hook is byte-compare idempotent (D98.A11): byte-identical + executable → no-op; byte-identical + non-executable (Unix only) → chmod-only repair; bytes differ → atomic refresh to the current template via `writeFileAtomic`.

Out of scope in v0.7.0-beta: husky / lefthook adapter integration (deferred to M G1's `installers` package — refusal-on-detection is intentional), worktree / submodule support (`.git`-as-pointer-file), git `core.hooksPath` redirect detection (install succeeds but the hook won't fire if `core.hooksPath` points elsewhere; a future `viberevert doctor` diagnostic will flag this), Windows-native git without `sh.exe` (git itself does not execute the hook on that platform — not a vibe-revert limitation), and any second severity threshold beyond what `check --staged` already enforces (`risk.block_on` is the single knob).

See [`docs/hook-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/hook-contract.md) for the full contract: refusal copy table, exit-code policy (D98.K + D98.F translation), hook script verbatim text, `--force` scope lock, `--restore` validate-before-mutate semantics, metadata-fingerprint guard, and architectural invariants (D98.M.1-14).

## Install / uninstall integrations

`viberevert install` writes VibeRevert integration configuration for one or more adapters, driven through `@viberevert/installers`. Each per-adapter flag targets one integration:

- `viberevert install --cursor` — merge the VibeRevert MCP server into `.cursor/mcp.json`.
- `viberevert install --claude` — merge into `.mcp.json`.
- `viberevert install --direct` — write `.git/hooks/pre-commit` directly.
- `viberevert install --husky` — insert a VibeRevert block into `.husky/pre-commit`.
- `viberevert install --lefthook` — insert a VibeRevert block into the detected Lefthook config.
- `viberevert install --github-action` — write the pinned CI workflow at `.github/workflows/viberevert.yml`.
- `viberevert install --all` — iterate the five safe adapters (cursor, direct-hook, husky, lefthook, claude). GitHub Action is explicit-only.

`--dry-run` prints per-file diffs instead of writing. `--force-reinstall` narrowly overrides recorded-SHA drift refusals, and the GitHub Action adapter's user-authored-workflow refusal. It does not bypass locks, journals, symlink refusals, parent-escape refusals, target-shape refusals, target-size refusals, or other adapter-layer structural refusals. `--migrate-from-hook-install` orchestrates a two-step Husky migration when a VibeRevert direct hook is already present.

CLI output uses a locked bracket vocabulary, one line per selected adapter:

- `[applied: <adapter>: <humanSummary>]` — install succeeded.
- `[noop: <adapter>: <reason>]` — record already matches desired state.
- `[skipped: <adapter>: <reason>]` — adapter `detect` returned false for the selected intent.
- `[refused: <adapter>: <code>: <message>]` — adapter or engine refusal.
- `[applicable: <adapter>: <humanSummary>]` + indented diff — `--dry-run` only.

`viberevert uninstall` mirrors the flag surface (except no `--dry-run`, and `--force` instead of `--force-reinstall`). Output uses `[uninstalled]`, `[noop]`, or `[refused]`.

`viberevert install` writes the durable record at `.viberevert/integrations.json`; `viberevert uninstall` reads and removes records from that file. That file should be committed. Transient paths under `.viberevert/` — `integration-backups/`, `integration-journal/`, `integrations.lock/` — should be gitignored.

See [`docs/installers-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/installers-contract.md) for the full contract: per-adapter conflict behavior, drift semantics, migration choreography, error taxonomy, and locked-copy reason codes.

## MCP server

`viberevert mcp serve` boots a local Model Context Protocol server over stdio that exposes VibeRevert's read-only and local-write tools to AI coding agents. The server is config-blind (no `.viberevert.yml` required) and binds to the repository it was launched in — one server, one repository, one audit log at `.viberevert/mcp-audit.log`.

Eight tools are exposed in v0.7.0-beta: `check_repo`, `explain_diff`, `classify_risk`, `list_risky_files`, `get_policy` (read-only); `start_session`, `create_checkpoint`, `generate_fix_prompt` (local-write). Two names are reserved and intentionally hidden from `tools/list`: `rollback` and `request_human_approval` — both return a generic `Tool not found` envelope identical to any other unknown name, with no leak of "exists but blocked".

Raw tool arguments are NEVER logged to the audit; records contain call metadata such as tool name, timestamp, ok/exit-code, and duration. Stdin EOF triggers graceful shutdown, with in-flight tool calls allowed to complete before the process exits.

Out of scope in v0.7.0-beta: HTTP / SSE transport (stdio only), per-tool `cwd` parameter (confused-deputy risk), execution tools beyond the three local-write tools above, and cross-repository operation.

See [`docs/mcp-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/mcp-contract.md) for the full contract: tool input/output shapes, dispatcher matrix, audit record shapes, output caps, timeout policy, library discipline, and architectural invariants (D99.M.1-22).

## License

Apache-2.0. See the repository [LICENSE](https://github.com/madeinplutofabio/vibe-revert/blob/main/LICENSE) and [NOTICE](https://github.com/madeinplutofabio/vibe-revert/blob/main/NOTICE).
