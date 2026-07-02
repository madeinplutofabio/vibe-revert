# @viberevert/installers

> Non-destructive third-party config writers.

The installer engine for VibeRevert integrations. Consumes adapter plans from `@viberevert/adapters` and applies them under a per-repo lock with a pre-mutation recovery journal, so a crashed install cannot silently clobber user files.

Shipped integrations in `v0.7.1-beta.0`: `cursor`, `direct-hook`, `husky`, `lefthook`, `claude`, `github-action`. Codex deferred pending upstream stability (M G1b-followup-3). Global (home-dir) installs deferred to a future milestone (M G1b-followup-10).

The engine exposes three entry points:

- `preview(plan, ctx)` — read-only classification with per-file unified diffs.
- `apply(plan, ctx)` — mutating install; acquires the lock, refuses on pending journal, writes backups and target files, commits the record.
- `uninstall(recordKey, ctx)` — mutating removal; drift-checked at the recorded managed-region SHA.

Persistence lives at `.viberevert/integrations.json`, validated against a Zod schema on every read and write. Managed-value hashing uses a canonical-JSON form (sorted keys, compact, UTF-8) so the same value written with different source-code key order hashes identically.

**Repo hygiene.** The store (`.viberevert/integrations.json`) should be committed. The transient paths — `.viberevert/integration-backups/`, `.viberevert/integration-journal/`, and `.viberevert/integrations.lock/` — should be gitignored. See the `.gitignore` expectations section of the contract doc for the exact patterns.

See [`docs/installers-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/installers-contract.md) for the full contract: outcome shapes, sentinel-block format, JSON-key-merge rules, canonical JSON spec, lock/journal semantics, error taxonomy, and per-adapter behavior.

Part of [VibeRevert](https://github.com/madeinplutofabio/vibe-revert) — the safety belt for vibe coding.

**Status:** Introduced for the `v0.7.1-beta.0` release line (M G1b). Public API may change before v1.0.

## License

Apache-2.0. See the repository [LICENSE](https://github.com/madeinplutofabio/vibe-revert/blob/main/LICENSE) and [NOTICE](https://github.com/madeinplutofabio/vibe-revert/blob/main/NOTICE).
