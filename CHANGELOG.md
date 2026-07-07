# Changelog

All notable changes to VibeRevert will be documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `viberevert run [--task "..."] <command> [args...]` -- runs a single
  command inside a VibeRevert session: checkpoint, start session, spawn the
  child (`stdio: "inherit"`, `shell: false` -- no shell, no PTY), end the
  session, and print a `viberevert check --since <session>` hint. Guarding
  via `.viberevert.yml` `commands.guard` (refuse, exit 2) and
  `commands.require_confirm` (interactive `run anyway` on a TTY; refuse on a
  non-TTY) applies to the top-level invocation only; guard wins when both
  match. Child exits propagate verbatim; wrapper spawn failures map to 127
  not-found / 126 not-executable, and POSIX signal death maps to 128+N.
  One JSONL audit line per run appended to the session's `commands.log`
  (argv recorded verbatim -- no secret redaction). The init framework
  profiles (nextjs, laravel, rails, python, lovable) ship live guard/confirm
  defaults; the generic profile ships a commented example. See
  `docs/run-contract.md`.
- `viberevert shell [--task "..."]` -- opens a guarded command loop (REPL)
  inside a single VibeRevert session: takes a checkpoint, starts one session,
  then prompts `viberevert> ` for one command at a time, guard-checks each
  command before running it, and -- on `exit` / EOF -- ends the session and
  prints the `viberevert check --since <session>` hint. The interactive
  companion to `viberevert run`. Each line is tokenized by a v1 parser with NO
  shell expansion (globs/vars/operators are literal; use `sh -c` / `cmd /c` for
  shell features); each accepted command spawns with `stdio: "inherit"`,
  `shell: false` at the fixed launch cwd (no `cd`). Guard/confirm matching is
  shared with `run`, but a refusal or declined confirmation SKIPS that command
  and CONTINUES the loop (a non-TTY confirm is refused without consuming a
  line). One JSONL `commands.log` entry per accepted command, appended BEFORE
  the spawn (so ENOENT / failed-spawn commands are still logged); per-command
  child exits are displayed (`[exit: N]` / `[signal: SIG]`) and swallowed,
  never propagated to the shell's own exit code. Scoped teardown: the shell
  never ends a session it does not own. No `node-pty` / native dependency --
  the transparent terminal bridge is deferred to G4. See
  `docs/shell-contract.md`.

## [0.7.1-beta.1] - 2026-07-04

> Note: `v0.7.1-beta.0` was a partial release. The CI publish run
> shipped 5 of 10 packages before halting on missing npm Trusted
> Publisher configuration for the two first-release packages. Those two
> packages were then manually bootstrapped at `0.7.1-beta.0` so Trusted
> Publisher could be configured. `v0.7.1-beta.1` supersedes it as the
> canonical release of this line.

### Added

- `@viberevert/adapters` (first public release) — read-only detect +
  plan for six adapter surfaces: Cursor project-local MCP, Claude Code
  project-local MCP, Husky pre-commit sentinel block, Lefthook config
  sentinel block, direct git hook, GitHub Action workflow template.
- `@viberevert/installers` (first public release) — non-destructive
  installer engine (`preview` / `apply` / `uninstall`) with per-repo
  cross-platform lock, pre-mutation recovery journal, per-kind
  managed-region SHA drift detection, canonical-JSON hashing, symlink
  refusal, 1 MiB JSON merge-target ceiling, and generated managed
  content uses LF.
- `viberevert install` and `viberevert uninstall` -- per-adapter flags
  plus `--all` (five safe adapters; GitHub Action explicit-only),
  intent-gated detection, install `--dry-run` diffs, narrow install
  `--force-reinstall`, narrow uninstall `--force`, and
  `--migrate-from-hook-install` for direct-hook → Husky migration.
  Locked bracket output vocabulary: install
  `[skipped/refused/noop/applied/applicable]`, uninstall
  `[uninstalled/noop/refused]`. Records persisted in repo-local
  `.viberevert/integrations.json`. See `docs/installers-contract.md`.
- GitHub Action workflow template at
  `.github/workflows/viberevert.yml` -- pinned exact CLI version,
  `--since <sha>` PR/push diff ranges, `permissions: { contents: read }`,
  no `pull_request_target`, sentinel-replace on re-install.
- Hook manager delegation flip: M F's `viberevert hook install`
  refusal-on-detection flips to safe delegation when Husky or
  Lefthook adopt VibeRevert via the installers path; coexistence
  guard prevents double-install between direct hook and hook-manager
  adoption.

### Security

- GitHub Action template ships with `permissions: { contents: read }`
  at the workflow level and explicitly does NOT use
  `pull_request_target` (least-privilege).
- Refusal-first design: adapters and installer engine refuse on
  drift, on symlink targets, on non-repo paths, on oversize
  (> 1 MiB) JSON merge targets, on missing hook manager, on
  config-shape mismatch, and on pending recovery journal.
  `--force-reinstall` / `--force` is scope-narrow and cannot
  override structural refusals or the lock.
- Publish metadata was audited before release:
  `@viberevert/adapters/src` has no external non-node runtime
  imports; `@viberevert/installers` declares `@viberevert/adapters`,
  `diff`, and `zod`, with `diff` and `zod` as the only external
  non-node runtime imports.

### Documentation

- Added `docs/installers-contract.md` -- complete installer/adapter
  contract: terminology, adapter interface, AdapterContext,
  installer outcomes, FileEditOp variants, sentinel-block format,
  JSON-key-merge + canonical JSON, PathSpec, per-kind managed-region
  SHAs, backup layout, lock (D101.L), recovery journal (D101.M),
  recordKey enum, `.gitignore` expectations, integrations.json
  schema, GitHub Action template contract, CLI output vocabulary,
  error taxonomy, migration choreography, per-adapter behavior
  tables, and known follow-ups.
- Expanded `packages/adapters/README.md`,
  `packages/installers/README.md`, and `packages/cli/README.md` for
  the new install/uninstall CLI surface.
- Cross-linked `docs/hook-contract.md` to the new installers
  contract for the records-based install/uninstall flow.
- Removed stale capability claims about Codex / Copilot / Windsurf
  integrations, wrapper commands (`viberevert run` deferred to M G2),
  and policy packs that are not shipped yet. Affected: root
  `README.md`, `packages/cli/README.md`,
  `packages/installers/README.md`, `packages/adapters/README.md`,
  and `packages/policies-basic/README.md`.
- Added `docs/integrations.md` with the per-adapter ship-status
  table: cursor / claude / direct-hook / husky / lefthook /
  github-action shipped in M G1b; codex deferred pending the 90-day
  stability gate; global installs deferred to M G1b-followup-10.
- Updated per-package `Status:` lines to reflect the actual release
  shape: `v0.7.0-beta.0` published, first public release at
  `v0.7.1-beta.0`, or private stub through the `v0.7.1-beta.0`
  release line.
- Added `plans/milestone_rp_to_g1b_reconciliation.md` to document
  why the final M G1b scope differs from earlier drafts without
  rewriting the archived M RP plan.

### Architecture

- New package layer enforced by architectural invariant tests:
  `@viberevert/adapters` (READ-ONLY; hook surface + adapter
  contracts; never reads `integrations.json`) →
  `@viberevert/installers` (mutating engine, integrations store,
  lock, journal, `hasRepoIntegrationRecord` helper) →
  `@viberevert/cli-commands` (M F's hook-install + new
  `InstallCommand` / `UninstallCommand`; imports from adapters AND
  installers). Breaks the cycle that previously ran through M F's
  hook surface.
- Adapters return `AdapterPlan = ApplicablePlan | RefusedPlan` -- no
  `NoopPlan` in adapters; noop is the installer's job since it
  requires reading the integrations record + on-disk SHAs together.
- Installers return `InstallOutcome = applied | noop | refused`.
  Adoption of existing-matching-state is `applied` with
  `opsApplied: 0`.
- All installer writes go through a package-private
  `writeFileAtomic` (temp + rename via `wx`-flag exclusive create)
  under a per-repo lock (`.viberevert/integrations.lock/` atomic
  mkdir). Pre-mutation recovery journal
  (`.viberevert/integration-journal/<txn-id>.json`): a subsequent
  install refuses with `PendingIntegrationRecoveryError` and lists
  manual recovery steps.
- No home-directory writes; no `--global` flag;
  `.viberevert/integrations.json` is repo-local only (schema v1).

## [0.7.0-beta.0] - 2026-06-22

First public beta. Published to npm as `viberevert@beta` and the
seven supporting `@viberevert/*` packages at version `0.7.0-beta.0`.
See per-feature contract docs under `docs/` for authoritative shape
locks.

### Added

- `viberevert check` / `report` / `prompt-fix` -- risk classification,
  fix-prompt rendering, atomic temp+rename file writes (M B / M C / M E).
- `viberevert start` / `end` / `checkpoint` / `checkpoints` /
  `sessions` -- session + checkpoint lifecycle with ULID identifiers
  and per-session NDJSON audit (M B / M C).
- `viberevert rollback <session>` (dry-run by default, `--apply` to
  execute) -- restores tracked + untracked file content and git index
  from a session's pre-session snapshot; emits a structured rollback
  receipt; idempotent re-apply refusal (M D). See
  `docs/rollback-contract.md`.
- `viberevert hook install` / `hook uninstall` (POSIX + Windows
  semantics; `--force` backup; `--restore` round-trip) -- managed
  `pre-commit` hook that runs `viberevert check --staged` (M F). See
  `docs/hook-contract.md`.
- `viberevert mcp serve` -- Model Context Protocol server over stdio
  exposing 8 tools (check_repo, explain_diff, classify_risk,
  list_risky_files, get_policy, start_session, create_checkpoint,
  generate_fix_prompt). Reserved-but-hidden: rollback,
  request_human_approval (M G1a). See `docs/mcp-contract.md`.
- `viberevert init` / `doctor` / `--version` -- workspace
  initialization, environment diagnostics, version reporting (M B).

### Security

- No raw tool arguments in the MCP audit log (D99.J never-log-args).
- R31 reflection locks: arbitrary unknown tool names never echoed
  into responses or audit (`<unknown>` sentinel).
- MCP library never writes to `process.stdout` / `process.stderr` /
  `process.exit` (D99.M.14). CLI wrapper owns process exit + human
  stderr; MCP library returns/rejects.
- Cold-start lock (D99.M.12): MCP package (SDK + audit writer + Zod
  schemas + tool registry) loaded only when `viberevert mcp serve`
  is invoked; non-mcp commands pay zero MCP import cost.
- Audit `tool_name` sanitization: printable ASCII only, capped at
  64 chars (prevents NDJSON injection from malicious client names).

### Documentation

- `docs/rollback-contract.md` -- rollback receipt shape, dry-run vs
  apply semantics, scope-of-restore boundaries.
- `docs/prompt-fix-contract.md` -- fix-prompt rendering contract,
  D81 byte-identity discipline, target resolution.
- `docs/hook-contract.md` -- POSIX hook script template, managed-by
  marker, backup/restore semantics, Windows chmod no-op.
- `docs/mcp-contract.md` -- MCP server contract: 8 tools, envelope,
  4-category dispatcher matrix, 5 audit shapes, output caps,
  timeout policy, library discipline, 22 architectural invariants
  summary.
- `docs/release-process.md` -- local smoke-test workflow, packed-CLI
  validation against scratch repos.

### Architecture

- 12-package pnpm monorepo with explicit cross-package boundary
  invariants (22 D99.M architectural invariants for MCP boundaries;
  D98.M for hooks; D90 for prompt-fix; D77 for rollback).
- Node >=22, TypeScript 5.9, biome lint/format, vitest, clipanion 3.x.
- ASCII-only at byte level across MCP source (D99.M.13) and per-tool
  hook scripts (D98.M.4).

[Unreleased]: https://github.com/madeinplutofabio/vibe-revert/compare/v0.7.1-beta.1...HEAD
[0.7.1-beta.1]: https://github.com/madeinplutofabio/vibe-revert/releases/tag/v0.7.1-beta.1
[0.7.0-beta.0]: https://github.com/madeinplutofabio/vibe-revert/releases/tag/v0.7.0-beta.0
