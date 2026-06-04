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

## License

Apache-2.0. See the repository [LICENSE](https://github.com/madeinplutofabio/vibe-revert/blob/main/LICENSE) and [NOTICE](https://github.com/madeinplutofabio/vibe-revert/blob/main/NOTICE).
