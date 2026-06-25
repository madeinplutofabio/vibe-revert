# @viberevert/adapters

> Agent and tool integration adapters.

Read-only adapters that detect and plan VibeRevert integration writes for Claude Code (project-local), Cursor (project-local), GitHub Actions workflow text, direct `.git/hooks/` writes, and husky / lefthook hook managers. Owns the single implementation of hook-manager detection, hook script constants, and sentinel-block helpers shared with `@viberevert/cli-commands`. Never reads `.viberevert/integrations.json` because that is `@viberevert/installers`' job. Mutation is performed by `@viberevert/installers`; this package is read-only by design.

Part of [VibeRevert](https://github.com/madeinplutofabio/vibe-revert) — the safety belt for vibe coding.

**Status:** First public release at `v0.7.1-beta.0` (M G1b). Public API may change before v1.0.

## License

Apache-2.0. See the repository [LICENSE](https://github.com/madeinplutofabio/vibe-revert/blob/main/LICENSE) and [NOTICE](https://github.com/madeinplutofabio/vibe-revert/blob/main/NOTICE).
