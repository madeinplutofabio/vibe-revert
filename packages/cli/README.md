# viberevert

> The VibeRevert CLI.

The user-facing command-line tool. Provides `init`, `checkpoint`, `run`, `check`, `report`, `prompt-fix`, `rollback`, `hook install`, `hook uninstall`, and integration installers.

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

## Hook install / uninstall

`viberevert hook install` writes a deterministic POSIX `#!/bin/sh` pre-commit hook to `.git/hooks/pre-commit` that runs `viberevert check --staged` on every commit. The hook respects your `.viberevert.yml` `risk.block_on` threshold (default: `critical`); on exit 2 it prints a `viberevert prompt-fix` tip on stderr and translates to git-hook exit 1 so blocked commits abort uniformly. Use `git commit --no-verify` for a single-commit bypass; vibe-revert documents it but does not hide it.

Refuses cleanly on husky / lefthook detection (those ecosystems own their own hook lifecycle — invoke `viberevert check --staged` from your manager's pre-commit instead), on git worktree / submodule layouts (`.git`-as-pointer-file is not yet supported), on shared-hooks-directory setups (`.git/hooks` as symlink), and on malformed `package.json`. `--force` overrides ONLY the existing-non-viberevert-hook case (backing it up to `.git/hooks/pre-commit.viberevert-backup-<UTC>`); it does NOT override hook-manager / layout / malformed-JSON refusals — those are absolute.

`viberevert hook uninstall` removes the viberevert-managed hook (identified by an exact line-2 marker check with CRLF tolerance) and refuses to touch hooks it did not write. No `--force` flag: refusing to remove unknown hooks IS the safety belt. With `--restore`, it renames the most recent `pre-commit.viberevert-backup-<UTC>` file back to `.git/hooks/pre-commit` (validate-before-mutate per D98.P: the managed hook is NEVER deleted before backup existence is proven; metadata-fingerprint guard — dev + ino + size + mtimeMs + ctimeMs — catches in-place modification between the first and final stat). The safety posture is best-effort validate-before-mutate, not a cross-process lock.

Re-installing an existing managed hook is byte-compare idempotent (D98.A11): byte-identical + executable → no-op; byte-identical + non-executable (Unix only) → chmod-only repair; bytes differ → atomic refresh to the current template via `writeFileAtomic`.

Out of scope in v0.7.0-beta: husky / lefthook adapter integration (deferred to M G1's `installers` package — refusal-on-detection is intentional), worktree / submodule support (`.git`-as-pointer-file), git `core.hooksPath` redirect detection (install succeeds but the hook won't fire if `core.hooksPath` points elsewhere; a future `viberevert doctor` diagnostic will flag this), Windows-native git without `sh.exe` (git itself does not execute the hook on that platform — not a vibe-revert limitation), and any second severity threshold beyond what `check --staged` already enforces (`risk.block_on` is the single knob).

See [`docs/hook-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/hook-contract.md) for the full contract: refusal copy table, exit-code policy (D98.K + D98.F translation), hook script verbatim text, `--force` scope lock, `--restore` validate-before-mutate semantics, metadata-fingerprint guard, and architectural invariants (D98.M.1-14).

## License

Apache-2.0. See the repository [LICENSE](https://github.com/madeinplutofabio/vibe-revert/blob/main/LICENSE) and [NOTICE](https://github.com/madeinplutofabio/vibe-revert/blob/main/NOTICE).
