# @viberevert/adapters

> Agent and tool integration adapters.

Read-only adapters for VibeRevert integrations. Each adapter exposes exactly two methods — `detect(ctx)` reports whether the integration applies to the current repo and intent; `plan(ctx)` returns the desired file edit ops. Adapters do not mutate the filesystem and do not read `.viberevert/integrations.json`; mutation is performed by `@viberevert/installers`.

Shipped adapters in `v0.7.1-beta.0`:

- `cursor` — project-local `.cursor/mcp.json` merge.
- `direct-hook` — `.git/hooks/pre-commit` writer.
- `husky` — sentinel-block append into `.husky/pre-commit`.
- `lefthook` — sentinel-block insert into `lefthook.yml` (or the accepted variants).
- `claude` — project-local `.mcp.json` merge.
- `github-action` — pinned CI workflow at `.github/workflows/viberevert.yml`.

This package also owns the single implementation of hook-manager detection (`detectHookManagers`), the hook-script template + marker constants, and the sentinel-block helpers used by `@viberevert/installers` for text-file mutations.

See [`docs/installers-contract.md`](https://github.com/madeinplutofabio/vibe-revert/blob/main/docs/installers-contract.md) for the adapter interface, per-adapter behavior, and locked-copy identifiers.

Part of [VibeRevert](https://github.com/madeinplutofabio/vibe-revert) — the safety belt for vibe coding.

**Status:** Introduced for the `v0.7.1-beta.0` release line (M G1b). Public API may change before v1.0.

## License

Apache-2.0. See the repository [LICENSE](https://github.com/madeinplutofabio/vibe-revert/blob/main/LICENSE) and [NOTICE](https://github.com/madeinplutofabio/vibe-revert/blob/main/NOTICE).
