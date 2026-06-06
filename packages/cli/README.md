# viberevert

> The VibeRevert CLI.

The user-facing command-line tool. Provides `init`, `checkpoint`, `run`, `check`, `report`, `prompt-fix`, `rollback`, and integration installers.

Part of [VibeRevert](https://github.com/madeinplutofabio/vibe-revert) — the safety belt for vibe coding.

**Status:** `v0.7.0-beta` work in progress. Public API may change before v1.0.

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

## License

Apache-2.0. See the repository [LICENSE](https://github.com/madeinplutofabio/vibe-revert/blob/main/LICENSE) and [NOTICE](https://github.com/madeinplutofabio/vibe-revert/blob/main/NOTICE).
