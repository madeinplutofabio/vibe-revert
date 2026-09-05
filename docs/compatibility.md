# Compatibility and support

This page describes what VibeRevert supports, how mature each part is, and how
its interfaces may change while VibeRevert is in beta.

## Supported platforms and runtimes

- **Node.js 22 or newer** (matching the package's `engines` field).
- **Linux, macOS, and Windows.**

VibeRevert is validated in CI against a pinned release-qualification Node version
and a moving compatibility version on each platform. The exact runner-and-version
matrix, and what each cell proves, is declared in the
[`support.yml`](../support.yml) manifest and enforced against the CI workflow.

## Feature maturity

- **Beta.** The non-live-PTY product surface identified as `core_non_live_pty` in
  `support.yml` is at beta maturity — for example `init`, `check`, `rollback`,
  sessions and checkpoints, git hooks and installers, and the MCP server. It is
  usable and tested; its public interfaces may still change under the change
  policy below.
- **Experimental.** PTY-based command interception (`viberevert shell --pty`),
  identified as `live_pty_interception`, is experimental; see
  [Experimental features](#experimental-features).

## Public compatibility surfaces

This policy covers:

- Documented CLI commands and options ([Commands](commands.md)).
- The documented `.viberevert.yml` schema ([Configuration](config.md)).
- Persisted formats and the exported schema surface described in
  [Session format](session-format.md).
- Documented MCP tool contracts ([MCP contract](mcp-contract.md)).

This list does not make incidental terminal formatting, log wording, or internal
module paths compatibility guarantees unless another contract explicitly says so.

## Change policy during beta

VibeRevert is pre-1.0. Public interfaces may still change.

- Incompatible changes to documented public surfaces must be identified in the
  release notes.
- Migration guidance is provided when users need to change commands,
  configuration, persisted data, or integrations.
- New optional fields and additive capabilities may be introduced without being
  treated as incompatible changes, provided existing required behavior remains
  valid.
- Experimental surfaces have weaker compatibility guarantees and may change
  incompatibly between releases.

After 1.0, public API versioning follows semantic-versioning rules.

## Persisted formats

Persisted artifacts declare independent schema versions, and VibeRevert validates
them against those versions (see [Session format](session-format.md)).

An incompatible format change requires updated schemas and documented migration
guidance. Schema versions do not advance merely because the package version
changes. Per-release guidance, including which capabilities an older session
does and does not gain after an upgrade, is in
[MIGRATIONS.md](../MIGRATIONS.md).

An older VibeRevert release is not guaranteed to read artifacts written by a
newer release. These schemas reject unknown fields rather than ignoring them, so
downgrading across a format addition fails loudly at parse time rather than
silently discarding data.

## Experimental features

Experimental features have weaker compatibility guarantees than beta features.
Their behavior and interface may change incompatibly between releases, and
automation should not depend on them. Today the experimental surface is PTY
interception (`viberevert shell --pty`), whose command interception is
best-effort and platform-dependent — see the [PTY contract](pty-contract.md).
