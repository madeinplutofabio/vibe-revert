# `viberevert hook install` / `viberevert hook uninstall` — Contract & Refusal Rules

Canonical contract surface for the two `viberevert hook` subcommands. Read this before wrapping them in higher-level tooling (MCP `hook_install` / `hook_uninstall` integrations, CI scripts that install/uninstall hooks programmatically, husky/lefthook adapter work in M G1).

This document is the source of truth for M F's locked behavior. The CLI's `--help`, the hook script body emitted on disk, and integration code should all match what's described here. When in doubt, this file wins.

For the newer records-based install/uninstall flow, including coexistence with direct hooks, Husky, Lefthook, Cursor, Claude Code, and GitHub Action, see [`docs/installers-contract.md`](installers-contract.md).

---

## Synopsis

```sh
viberevert hook install           # default — write .git/hooks/pre-commit
viberevert hook install --force   # back up any existing non-viberevert hook, then write
viberevert hook uninstall         # default — remove a viberevert-managed pre-commit hook
viberevert hook uninstall --restore  # remove + restore the most recent --force backup
```

**Mutual exclusion:** `--force` is install-only. `--restore` is uninstall-only. Neither command accepts the other's flag (clipanion parse-time refusal).

**Scope of `--force`:** only overrides the existing-non-viberevert-hook refusal. Does NOT override husky/lefthook detection, `.git`-not-a-directory refusal, `.git/hooks`-not-a-directory refusal, or malformed package.json refusal. Those refusals are absolute.

**No other command-specific flags.** No `--json`, no `--markdown`, no `--dry-run`. (Clipanion's standard `--help` is available on all commands as usual.) The hook commands are direct config mutators with deterministic behavior; the user reads stdout for the outcome.

---

## What `hook install` does

Writes a deterministic POSIX `sh` pre-commit hook to `.git/hooks/pre-commit` that runs `viberevert check --staged` on every `git commit`. The hook:

- Allows commits where `check` exits 0 (no findings at or above `risk.block_on`).
- Aborts commits where `check` exits 2 (findings at or above `risk.block_on`), printing the check output plus a tip suggesting `viberevert prompt-fix`.
- Aborts commits where `check` exits 1 (check internal/config error), printing the error output WITHOUT the prompt-fix tip (running prompt-fix when check itself errored would be misleading).

**Inputs:** the repo root (resolved via `@viberevert/core`'s `resolveRepoRoot`). No config load (`hook install` is config-blind; the hook AT RUNTIME loads config via `viberevert check`'s normal path).

**Output:** writes `.git/hooks/pre-commit` atomically (`writeFileAtomic` + temp+rename), chmods 0o755 (no-op on Windows). Stdout: deterministic human-readable success copy. Clean install prints the locked three-line install message; re-install/update paths print the locked one-line status messages (see the install behavior table below for exact wording per outcome).

**Idempotency:** re-running `hook install` against an existing viberevert-managed hook is safe and supported. Behavior splits three ways based on the existing hook's byte-content + execute-bit state:

| Existing state | Behavior | Stdout |
|---|---|---|
| Byte-identical to current template AND executable (Unix) / byte-identical (Windows) | No write, no chmod | `VibeRevert pre-commit hook already installed at <path> (byte-identical to current template; no changes needed).` |
| Byte-identical to current template AND non-executable (Unix only) | chmod 0o755 only (no write) | `VibeRevert pre-commit hook already installed at <path> (byte-identical to current template; executable permissions refreshed).` |
| Bytes differ (e.g., after a vibe-revert upgrade) | Atomic write + chmod | `VibeRevert pre-commit hook updated at <path> (existing managed hook refreshed to current template).` |

The byte comparison uses `Buffer.equals` (raw octets), NOT string comparison — this catches CRLF drift that would otherwise silently pass a string-equality check. A CRLF-converted viberevert hook (e.g., from editor / git autocrlf) is still recognized as managed (marker check has narrow CRLF tolerance) and gets refreshed to canonical LF on re-install.

---

## What `hook uninstall` does

Removes a viberevert-managed `.git/hooks/pre-commit` hook. Refuses if the file isn't viberevert-managed (missing marker, non-regular file, etc.) — vibe-revert never removes hooks it didn't write.

**Default behavior (no `--restore`):**
- Removes the viberevert hook via `rm`.
- Leaves any `pre-commit.viberevert-backup-*` files in place — user can `ls .git/hooks/` to manage backups manually.
- Exits 1 with `HookNotFoundError` if `.git/hooks/pre-commit` doesn't exist (nothing to uninstall).
- Exits 1 with `HookNotViberevertManagedError` if the file exists but the marker check fails (the file is not ours; refuse to remove).

**With `--restore`:**
- Removes the viberevert hook (if present and managed) AND restores the most recent `pre-commit.viberevert-backup-<YYYYMMDDTHHMMSSZ>` file as the new `.git/hooks/pre-commit`.
- Validates BEFORE mutating — if no valid backup exists, the existing managed hook is NEVER deleted.
- Skips chmod on the restored entry when the backup was non-regular (symlink, directory, etc.) to avoid following the symlink and mutating the link target's mode.

**No `--force` flag on uninstall.** Refusing to uninstall a hook we didn't write is the safety belt; an escape hatch would defeat the belt. Users who want to nuke `.git/hooks/pre-commit` regardless of provenance can `rm .git/hooks/pre-commit` themselves.

---

## What the hook script does at runtime

The on-disk `.git/hooks/pre-commit` is this exact byte content (ASCII-only, LF line endings, locked verbatim — re-running `hook install` after any drift refreshes to this):

```sh
#!/bin/sh
# managed-by: viberevert (https://github.com/madeinplutofabio/vibe-revert)
#
# This pre-commit hook runs `viberevert check --staged` on every commit.
# Exit code 0 allows the commit.
# Exit code 2 aborts the commit and prints a prompt-fix tip.
# Exit code 1 aborts the commit without a prompt-fix tip because check itself failed.
#
# To bypass this hook for a single commit:
#   git commit --no-verify
#
# To remove this hook:
#   viberevert hook uninstall
#
# vibe-revert respects your .viberevert.yml configuration. Adjust the
# `risk.block_on` threshold there (default: critical) to control what
# severity of findings aborts the commit.

viberevert check --staged
EC=$?

if [ "$EC" -eq 2 ]; then
  echo "" >&2
  echo "Tip: run \`viberevert prompt-fix\` to generate a fix-prompt for your coding agent." >&2
  exit 1
fi

exit "$EC"
```

**Runtime exit-code mapping (locked):**

| `check --staged` exit | Hook action | Hook exit |
|---|---|---|
| 0 | Allow commit | 0 |
| 2 | Block commit; preserve check output; print prompt-fix tip to stderr | 1 |
| 1 | Block commit; preserve error output; NO prompt-fix tip | 1 |
| other (127 command-not-found, etc.) | Block commit; passed through as-is | passthrough |

The exit-2 → exit-1 mapping is intentional: git treats any non-zero hook exit as "hook said no, abort commit." Exit 1 is the universal "hook failed" signal; some CI tools treat exit 2 specially. Translating to exit 1 keeps the hook's failure signature uniform.

**No `set -e`** in the script body — intentional. `set -e` would short-circuit before `EC=$?` captures the exit code, breaking the conditional tip-print branch. The cost: if `viberevert` isn't on PATH (rare; e.g., fnm/nvm with stripped hook PATH), the shell exits 127 — git treats that as failure, which is the right behavior for "command not found."

**The hook does NOT auto-run `viberevert prompt-fix`.** It prints a one-line suggestion on exit 2. The user (or their agent) decides when to engage prompt-fix. Auto-running would add latency to every blocked commit and subtly change the hook from "gate" to "agent-handoff workflow."

---

## Default behavior + persistence layout

The hook is written to `<repoRoot>/.git/hooks/pre-commit`. Backups (from `hook install --force`) go beside it as `<repoRoot>/.git/hooks/pre-commit.viberevert-backup-<YYYYMMDDTHHMMSSZ>` (UTC timestamp, colon-free for filesystem safety, lexicographically sortable equals chronologically sortable).

The hook script body is fully deterministic — no per-repo content, no version embedding, no timestamps. Two `viberevert hook install` invocations in two different repos produce byte-identical `.git/hooks/pre-commit` files.

---

## Managed-hook identification

A pre-commit hook is considered viberevert-managed only when all of the following are true:

1. `.git/hooks/pre-commit` is a regular file according to `lstat` (`stat.isFile() === true`).
2. The file's second line exactly equals `MANAGED_BY_MARKER`.
3. Narrow CRLF tolerance is allowed: the second line may equal `MANAGED_BY_MARKER + "\r"`.

The marker check is intentionally NOT `content.includes(MANAGED_BY_MARKER)` and NOT a prefix check. Marker text on any line other than line 2 does not count. Marker text embedded inside another comment does not count. Extra trailing characters after the marker do not count, except for the single CRLF artifact `"\r"`.

Non-regular paths are never marker-read. Symlinks, directories, sockets, fifos, and other non-regular inode types are treated as not viberevert-managed without calling `readFile(hookPath)`. This prevents accidental symlink-following during marker verification.

---

## Git hook layout support scope

M F supports only standard `.git`-as-directory repositories. For `hook install`, `.git/hooks` may be absent and is created only after all upstream refusal checks pass; if present, it must be a real directory. For `hook uninstall`, `.git/hooks` must already be a real directory.

**`.git` validation (per D98.V):**

| `.git` state | Behavior |
|---|---|
| Absent | Refuse with `UnsupportedGitHookLayoutError` (signal: `not-found`) |
| Regular file (git worktree / submodule pointer) | Refuse (signal: `regular-file`) |
| Symlink / socket / fifo / other | Refuse (signal: `other`) |
| Directory | Proceed |

**`.git/hooks` validation (per D98.X):**

| `.git/hooks` state | Install behavior | Uninstall behavior |
|---|---|---|
| Absent | Deferred — mkdir on the write path only after all upstream refusals pass | Refuse: `HookNotFoundError` (default) or `NoBackupsFoundError` (--restore) |
| Regular file | Refuse with `UnsupportedGitHooksDirectoryError` (signal: `regular-file`) | Same |
| Symlink (shared-hooks-directory layout) | Refuse with `UnsupportedGitHooksDirectoryError` (signal: `symbolic-link`) | Same |
| Other | Refuse (signal: `other`) | Same |
| Directory | Proceed | Proceed |

**Why this scope:** worktree/submodule layouts (where `.git` is a pointer file containing `gitdir: ...`) need parsing the pointer OR shelling out to `git rev-parse --git-path hooks` — both expand the locked filesystem surface beyond M F's scope. Shared-hooks-directory setups (where `.git/hooks` is a symlink) are similar. v0.7.0-beta refuses cleanly; M G/M H may add proper support alongside their git-plumbing work.

`--force` does NOT override these refusals.

---

## Detection signals (husky / lefthook)

`hook install` detects husky and lefthook before any filesystem mutation. If either (or both) is present, install refuses with guidance to use the existing hook manager.

**husky detection signals (first-match-wins precedence):**

1. `.husky/` directory exists
2. Top-level `husky` key in `package.json`
3. `husky` in `package.json` `devDependencies`
4. `husky` in `package.json` `dependencies`

**lefthook detection signals (first-match-wins precedence):**

1. `lefthook.yml`
2. `lefthook.yaml`
3. `.lefthook.yml`
4. `.lefthook.yaml`
5. `lefthook-local.yml`
6. `lefthook` in `package.json` `devDependencies`
7. `lefthook` in `package.json` `dependencies`

**Both-detected behavior:** if husky AND lefthook both detect, `HookManagersDetectedError` fires with husky's locked refusal copy first, then a blank line, then lefthook's locked refusal copy. The user is told to remove one (or both) of the hook managers.

**Malformed `package.json` refusal:** if `package.json` exists but is unparseable JSON, install refuses with `MalformedPackageJsonError` (NOT silently treats as "no managers detected"). This protects users who DO have husky/lefthook configured but temporarily broken JSON.

**`--force` does NOT override these refusals.** Use your hook manager directly (per Husky and lefthook section below).

---

## Refusal conditions table

`hook install` exit-1 paths. Only the existing-non-viberevert-hook refusal (#9) can be avoided by re-running with `--force`; `--force` does NOT override any other refusal in v0.7.0:

| # | Refusal | Class | Mutates? |
|---|---|---|---|
| 1 | No git repository | `RepoRootNotFoundError` | — |
| 2 | `.git` absent / regular file / other | `UnsupportedGitHookLayoutError` | — |
| 3 | husky detected | `HuskyDetectedError` | — |
| 4 | lefthook detected | `LefthookDetectedError` | — |
| 5 | husky + lefthook both detected | `HookManagersDetectedError` | — |
| 6 | Malformed `package.json` | `MalformedPackageJsonError` | — |
| 7 | Manager-detection I/O failure (non-ENOENT) | `HookManagerIoError` | — |
| 8 | `.git/hooks` not a directory | `UnsupportedGitHooksDirectoryError` | — |
| 9 | Existing non-viberevert pre-commit hook (no `--force`) | `ExistingNonViberevertHookError` | — |
| 10 | `--force` backup-path collision | `BackupCollisionError` | — |
| 11 | I/O failure (lstat/readFile/rename/mkdir/writeFileAtomic/chmod) | `HookInstallIoError` | — |
| 12 | Existing `direct-hook` integration record (M G1b coexistence guard) | `IntegrationsRecordsHookConflictError` | — |

`hook uninstall` exit-1 paths:

| # | Refusal | Class | Mutates? |
|---|---|---|---|
| 1 | No git repository | `RepoRootNotFoundError` | — |
| 2 | `.git` not a directory | `UnsupportedGitHookLayoutError` | — |
| 3 | `.git/hooks` not a directory (present-but-wrong-type) | `UnsupportedGitHooksDirectoryError` | — |
| 4 | `.git/hooks/pre-commit` absent (default uninstall) | `HookNotFoundError` | — |
| 5 | `.git/hooks` absent + `--restore` | `NoBackupsFoundError` | — |
| 6 | Pre-commit not viberevert-managed (missing marker / non-regular) | `HookNotViberevertManagedError` | — |
| 7 | `--restore` with no backup files | `NoBackupsFoundError` | — |
| 8 | `--restore` with existing non-viberevert pre-commit | `RestoreTargetExistsError` | — |
| 9 | `--restore` final-collision-guard: pre-commit changed since validation | `RestoreTargetExistsError` | — |
| 10 | I/O failure | `HookUninstallIoError` | — |

**Mutation discipline:** domain refusals that fire BEFORE the write/restore phase do NOT mutate the filesystem — `hook install` performs all repo-layout / manager-detection / existing-hook validations before any `rename`, `mkdir`, `writeFileAtomic`, or `chmod`. Once the command enters an intended mutation path, later I/O failures CAN occur after an earlier successful mutation (e.g., backup rename succeeded but chmod then failed); those surface as `HookInstallIoError` with the operation tag identifying where the failure happened. `writeFileAtomic` (temp+rename) prevents partial hook content. `hook uninstall --restore` specifically validates backup existence BEFORE removing the current managed hook — if no valid backup exists, the managed hook is NEVER deleted (this is the only mutation-order guarantee that's bulletproof across I/O failures).

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Install/uninstall succeeded. |
| 1 | Any refusal (table above) or unhandled I/O failure. |
| 2 | **NEVER.** Hook install/uninstall are config mutators, not gates. |

(The hook script ITSELF — the on-disk `.git/hooks/pre-commit` — translates `check --staged` exit codes per the runtime mapping in the "What the hook script does at runtime" section. That's a separate concern from `hook install` / `hook uninstall`'s own exit codes.)

CI scripts wrapping `viberevert hook install` / `uninstall`: distinguish 0 from 1 only.

---

## The `--no-verify` bypass

`git commit --no-verify` skips ALL git hooks for that one commit — including the viberevert pre-commit hook. This is intentional standard git behavior, not a vibe-revert feature; the viberevert hook documents it honestly rather than hiding it.

**When to use `--no-verify`:**

- Legitimate WIP commits where you know you'll fix things up before the next commit.
- Emergency fixes where you need to commit fast and accept the risk.
- Working through a transition where the check is incorrectly flagging something — track the false-positive separately and re-enable the gate on the next commit.

**What `--no-verify` does NOT bypass:**

- CI checks downstream (pull-request gating, branch protection).
- The next `git commit` (which will run the hook normally).
- Any non-hook checks the user runs manually.

**Pre-commit hooks are non-interactive by design.** Use `risk.block_on: high` in `.viberevert.yml` if your team wants high findings to block commits. Use `git commit --no-verify` only as an explicit Git bypass; VibeRevert documents it but does not hide it.

---

## Husky and lefthook

Husky and lefthook are intentionally not modified in v0.7.0-beta. Add `viberevert check --staged` manually to your hook manager, or wait for M G1 adapters.

**If husky is detected** and you still want vibe-revert to gate commits, add this line to your husky pre-commit hook (typically `.husky/pre-commit`):

```sh
viberevert check --staged
```

**If lefthook is detected**, add `viberevert check --staged` to your `lefthook.yml` pre-commit commands:

```yaml
pre-commit:
  commands:
    viberevert-check:
      run: viberevert check --staged
```

**Forward path:** M G1's `installers` package will introduce proper `HuskyAdapter` and `LefthookAdapter` implementations of the `{ detect, plan, apply, record, uninstall }` Installer interface. When those land, `viberevert hook install` against a husky/lefthook repo will delegate to the appropriate adapter instead of refusing.

---

## Coexistence with `viberevert install` (M G1b)

Starting in v0.7.1-beta.0, two install paths overlap at `.git/hooks/pre-commit`:

- **`viberevert hook install`** (M F) — this document's primary subject; writes the deterministic hook template directly.
- **`viberevert install --direct`** (M G1b) — writes the same template AND tracks the installation in `.viberevert/integrations.json` for later `uninstall --direct` / drift refusal / migration.

To prevent double-management (where both paths think they own `.git/hooks/pre-commit`), `viberevert hook install` refuses when `.viberevert/integrations.json` already records a `direct-hook` integration.

### The `IntegrationsRecordsHookConflictError` refusal

`viberevert hook install` calls a compatibility guard between `.git` validation and hook-manager detection. If a direct-hook integration record is present, the guard throws `IntegrationsRecordsHookConflictError` and hook install:

- Prints a two-part stderr message (the refusal + two recovery paths).
- Exits 1 without touching `.git/hooks/pre-commit` (no backup created either — the guard fires BEFORE the rename step).

`--force` does NOT override this refusal. Per the locked `--force` scope, `--force` only overrides the existing-non-viberevert-hook refusal (#9 in the refusal table); integrations-record conflicts are outside that scope.

**Recovery paths** (both listed in the error message):

1. **Remove the direct-hook integration record**: `viberevert uninstall --direct` reverses the M G1b install (unlinks `.git/hooks/pre-commit`, removes the record). `viberevert hook install` then proceeds normally.
2. **Migrate to Husky**: `viberevert install --husky --migrate-from-hook-install` moves the tracked direct hook into a Husky-managed sentinel block (see below).

### Husky migration story

When the user runs `viberevert install --husky --migrate-from-hook-install` against a repo that already has a direct-hook integration record, the Husky adapter emits an `ApplicablePlan` with `meta.migrateFromDirectHook` set to `"true"` on the resulting integration record. **This is a SIGNAL, not an action** — the adapter itself does not remove the direct-hook record or file. The CLI-level install orchestration observes the meta marker after the Husky apply commits and explicitly calls `uninstall("direct-hook", ctx)` to complete the migration.

**Successful post-migration state:**

- `.viberevert/integrations.json` has a `husky` record with `meta.migrateFromDirectHook` set to `"true"` (durable audit context; preserved indefinitely).
- The `direct-hook` record is removed.
- `.git/hooks/pre-commit` is removed (write-new reverse = unlink).
- `.husky/pre-commit` contains the user's original husky boilerplate PLUS the VibeRevert sentinel block (`# viberevert:begin:viberevert-husky-pre-commit` ... `# viberevert:end:viberevert-husky-pre-commit`).

### Guard placement rationale

The guard runs at **Step 2.5** of `hook install`: AFTER `.git` validation (Steps 1 and 2) and BEFORE any hook-related filesystem check or mutation (Steps 3+). Placement rationale:

- **Non-git repos** still surface `RepoRootNotFoundError` (Step 1) or `UnsupportedGitHookLayoutError` (Step 2) FIRST, so the existing "must be a git repo" UX is unchanged when the integrations store is corrupt.
- The guard runs BEFORE Step 3 (hook-manager detection) and BEFORE Steps 5-7 (hook file inspection + backup rename), so a conflict aborts before any `.git/hooks/pre-commit` touch.

Installer store errors surfaced by the guard's underlying `hasRepoIntegrationRecord` call, such as corrupt `integrations.json` or wrong `schemaVersion`, propagate verbatim — they are NOT caught as known `hook install` errors and surface via clipanion's default handler with non-zero exit. Rationale: a corrupt integrations store is broken internal state that should not be masked by a "known refusal" message.

### Architectural invariant (D101.M.5)

The compatibility guard module (`packages/cli-commands/src/commands/hook-install-integrations-guard.ts`) is grep-locked to import EXACTLY one symbol from `@viberevert/installers` — `hasRepoIntegrationRecord`. No deep imports, no `readIntegrationsFile`, no engine internals, no schema/types. All store-read + validation logic lives in `@viberevert/installers`'s `integrations-query.ts`; the guard is a pure orchestration layer over that helper. The invariant is grep-enforced by `packages/cli/test/architectural-invariants.test.ts` under the D101.M.5 describe block.

---

## `risk.block_on` threshold policy

The pre-commit hook delegates gating to `viberevert check --staged` and uses check's exit code to decide the commit gate (with check exit 2 mapping to hook exit 1 after printing the prompt-fix tip; other exit codes are exited as-is). It does NOT implement its own severity threshold or typed-confirm flow.

Default behavior follows `risk.block_on` from `.viberevert.yml` with default `critical`. Teams that want `high` to block commits set:

```yaml
risk:
  block_on: high
```

The §17 `high=warn+typed-confirm` behavior (from the broader plan) is intentionally represented as configurable hard-blocking in hooks because pre-commit execution must be deterministic, non-interactive, and CI-safe.

**Hooks are non-interactive by design.** Use `risk.block_on: high` if your team wants high findings to block commits. Use `git commit --no-verify` only as an explicit Git bypass.

---

## Architectural invariants (D98.M)

The hook implementation is constrained by grep-based source-level invariants in `packages/cli/test/architectural-invariants.test.ts`:

1. **D98.M.1** — `hook-install.ts`, `hook-uninstall.ts`, and `hook-managers.ts` MUST NOT import `child_process` in any form.
2. **D98.M.2** — Same files MUST NOT import `@viberevert/checks` — the hook SHELLS OUT to `viberevert check`, doesn't link the engine.
3. **D98.M.3** — Same files MUST NOT import any known LLM SDK.
4. **D98.M.4** — `hook-script.ts` MUST be ASCII-only at byte level.
5. **D98.M.5** — `hook-script.ts` MUST NOT import anything except types.
6. **D98.M.6** — `hook-install.ts` filesystem-access surface LOCKED: exactly the patterns from `lstat(join(repoRoot, ".git")` / `lstat(hooksDir` (×2 preflight + post-mkdir) / `lstat(hookPath` / `readFile(hookPath` / `lstat(backupPath` / `rename(hookPath, backupPath` / `mkdir(hooksDir` / `writeFileAtomic(hookPath` / `chmod(hookPath`. No aliasing; no other fs calls; manager detection delegated to `hook-managers.ts`.
7. **D98.M.7** — `hook-uninstall.ts` filesystem-access surface LOCKED: `lstat(join(repoRoot, ".git")` / `lstat(hooksDir` / `lstat(hookPath` (×2 — presence + final collision guard) / `readFile(hookPath` / `rm(hookPath` / `readdir(hooksDir` with `withFileTypes: true` / `rename(backupPath, hookPath` / `chmod(hookPath`.
8. **D98.M.8** — Exactly ONE import of `HOOK_SCRIPT_TEMPLATE` in `hook-install.ts`; exactly ONE import of `MANAGED_BY_MARKER` in EACH of `hook-install.ts` AND `hook-uninstall.ts`; exactly ONE import of `detectHookManagers` AND exactly ONE source call site `detectHookManagers(repoRoot)` in `hook-install.ts`.
9. **D98.M.9** — `index.ts` imports `HookInstallCommand` AND `HookUninstallCommand` exactly once each AND registers each via `cli.register(...)` exactly once.
10. **D98.M.10** — `index.ts` registration order: `HookInstallCommand` immediately after `RollbackCommand`; `HookUninstallCommand` immediately after `HookInstallCommand`.
11. **D98.M.11** — `hook-managers.ts` filesystem-access surface LOCKED: only `lstat` against husky/lefthook signal paths + `readFile(packageJsonPath)`.
12. **D98.M.12** — Cross-command imports forbidden: `hook-install.ts` and `hook-uninstall.ts` cannot import from each other. Shared error classes (`UnsupportedGitHookLayoutError`, `UnsupportedGitHooksDirectoryError`) are re-defined locally in each.
13. **D98.M.13** — All three M F CLI source files MUST be ASCII-only at byte level — catches em-dashes, smart quotes, arrows in any context (strings, comments, identifiers).
14. **D98.M.14** — `hook-script.ts` MUST NOT assign `HOOK_SCRIPT_TEMPLATE` via a raw multi-line template literal (backtick-quoted multi-line string); use the locked `[...lines].join("\n") + "\n"` pattern.

---

## Out of scope (v0.7.0-beta)

**`viberevert hook install --pre-push`** / other hook types. Deferred. Pre-commit covers the highest-leverage gate; pre-push is M H polish.

**Hook-script body customization** (e.g., `--include-prompt-fix-output` flag that auto-runs prompt-fix). The hook is a gate, not a workflow — auto-running prompt-fix changes its semantic from "stop unsafe commit" to "prepare agent remediation." Deferred indefinitely.

**`viberevert hook status` command** (reports installed / missing / non-viberevert / husky-managed / lefthook-managed / worktree-unsupported). Deferred to M H `viberevert doctor` integration.

**Worktree / submodule support** (where `<repoRoot>/.git` is a regular file containing a `gitdir:` pointer). Requires either parsing the pointer file OR shelling out to `git rev-parse --git-path hooks`. Both expand the locked filesystem surface; both deferred to M G/M H alongside the broader git-plumbing surface those milestones already touch.

**Shared-hooks-directory support** (where `<repoRoot>/.git/hooks` is a symlink to another location). Some git wrappers use this. Same deferral as worktree support.

**`core.hooksPath` git config detection.** If a user has `git config core.hooksPath /some/other/path`, `viberevert hook install` writes `.git/hooks/pre-commit` successfully but git never invokes it (git looks at the configured path instead). v0.7.0-beta does not detect this — would require shelling out to `git config --get core.hooksPath` OR parsing `.git/config`, both expanding the locked filesystem surface. **Workaround:** if you've set `core.hooksPath`, manage the hook at the configured path directly OR wait for M H doctor integration that flags the mismatch.

**Husky / lefthook adapter integration.** Deferred to M G1's `installers` package — see Husky and lefthook section above.

---

## Future-proof note

**`HOOK_SCRIPT_TEMPLATE` is the v0.7.0 compatibility contract.** The on-disk hook content is deterministic; backward-recognition is anchored on the version-free marker `# managed-by: viberevert (https://github.com/madeinplutofabio/vibe-revert)`. If v0.8.x needs to upgrade v0.7.x-installed hooks, a SECOND marker line will be added AFTER the existing one — the v0.7-line marker stays stable for backward recognition. Existing `viberevert hook uninstall` in v0.7.5 will still recognize a hook installed by v0.7.0.

**Husky / lefthook adapters in M G1.** When they land, M F's refusal-on-detection flips to delegation — the user-facing experience improves without breaking M F's contract. `detectHookManagers` is the natural place from which M G1 adapters' `detect()` methods derive.

**MCP `hook_install` / `hook_uninstall` tools (likely M G1).** Thin wrappers around the M F `HookInstallCommand` / `HookUninstallCommand` execute paths. The exported file-local error classes (D98.R) let MCP typed-catch refusals and re-serialize to MCP's error envelope.

**GitHub Action template (M G1).** The hook's structure (`viberevert check --staged` → exit code → suggestion) maps almost 1:1 to a GH Action workflow shape. No code sharing needed in M F; the contract overlap makes the GH Action template trivially derivable.

---

## Common workflows

### Workflow A: install on a clean repo, then commit successfully

```sh
viberevert hook install
# → exit 0
# → "Wrote viberevert pre-commit hook at <path>. The hook runs `viberevert check --staged` on every commit; vibe-revert's `risk.block_on` threshold (default: critical) determines what aborts the commit. To bypass this hook for a single commit, use `git commit --no-verify`."

# normal commit on safe changes
git add README.md
git commit -m "docs: typo fix"
# → check exits 0; commit proceeds
```

### Workflow B: install, attempt risky commit, generate fix prompt

```sh
viberevert hook install

# stage something risky
git add src/config.py   # contains a possible secret

git commit -m "config"
# → check exits 2; hook prints the report; hook prints:
#   "Tip: run `viberevert prompt-fix` to generate a fix-prompt for your coding agent."
# → commit aborts (git treats hook exit 1 as fail)

viberevert prompt-fix
# → renders the deterministic prompt; pipe to your agent
```

### Workflow C: uninstall

```sh
viberevert hook uninstall
# → exit 0
# → "Removed viberevert pre-commit hook at <path>."
```

### Workflow D: `--force` over an existing non-viberevert hook + restore

```sh
# Repo already has a custom .git/hooks/pre-commit
viberevert hook install
# → exit 1
# → "Refusing to overwrite existing non-viberevert pre-commit hook at <path>. Re-run with --force to back it up to <backup-path> and install the viberevert hook."

viberevert hook install --force
# → exit 0
# → existing hook moved to .git/hooks/pre-commit.viberevert-backup-<UTC>
# → viberevert hook written

# Later: restore the original
viberevert hook uninstall --restore
# → exit 0
# → "Restored backup at <backup-path> to <hookPath> (most recent viberevert backup)."
```

### Workflow E: integrate vibe-revert into an existing husky setup

```sh
viberevert hook install
# → exit 1 with husky-detected refusal
# → "Detected husky configuration (.husky/ directory). vibe-revert does not install into husky-managed hooks in v0.7.0. ..."

# Add to your .husky/pre-commit manually:
echo 'viberevert check --staged' >> .husky/pre-commit

# vibe-revert now runs as part of your husky pre-commit pipeline
```

### Workflow F: idempotent re-install after a vibe-revert upgrade

```sh
# After upgrading vibe-revert (where HOOK_SCRIPT_TEMPLATE may have changed):
viberevert hook install
# → exit 0
# → If template unchanged: "VibeRevert pre-commit hook already installed at <path> (byte-identical to current template; no changes needed)."
# → If template changed: "VibeRevert pre-commit hook updated at <path> (existing managed hook refreshed to current template)."
# → If template unchanged but execute-bit stripped: "VibeRevert pre-commit hook already installed at <path> (byte-identical to current template; executable permissions refreshed)."
```

---

## Appendix: Locked user-facing copy (D98.O)

All success and refusal messages are locked verbatim by D98.O in the M F plan and asserted by integration tests. The implementation MUST emit these exact strings (with `<placeholder>` slots filled per their semantics). No generic `error: <message>` prefix is allowed for known refusals — known refusals write their own stderr text directly via the `handleKnownError()` pattern.

### Refusal stderr (exit 1)

**`RepoRootNotFoundError`** (reused from other commands; same copy):
```
No git repository or VibeRevert project found (walked up from cwd looking for .git or .viberevert.yml).
Run `viberevert init` to create a project here.
```

**`UnsupportedGitHookLayoutError`** (D98.V — install and uninstall, same copy; `<signal>` in "not-found" | "regular-file" | "other"):
```
Hook management requires a standard git repository layout (<repoRoot>/.git must be a directory). Detected: <signal>.
Git worktrees and submodules use indirected hook directories that vibe-revert does not yet support in v0.7.0-beta. See docs/hook-contract.md for the deferred-feature note.
```

**`UnsupportedGitHooksDirectoryError`** (D98.X — install and uninstall, same copy; `<signal>` in "regular-file" | "symbolic-link" | "other"):
```
Hook management requires .git/hooks to be a real directory at <path>. Detected: <signal>.
Shared-hooks-directory setups (where .git/hooks is a symlink to another location) are not supported in v0.7.0-beta. Manage the hook at the symlink target manually, or wait for M G/M H support.
```

**`ExistingNonViberevertHookError`** (install without --force):
```
Refusing to overwrite existing non-viberevert pre-commit hook at <path>.
Re-run with --force to back it up to <backup-path> and install the viberevert hook.
```

**`HuskyDetectedError`** (install, husky only; `<signal>` in ".husky/ directory" | "package.json `husky` key" | "package.json `husky` in devDependencies" | "package.json `husky` in dependencies"):
```
Detected husky configuration (<signal>). vibe-revert does not install into husky-managed hooks in v0.7.0.
Manage your pre-commit through husky directly, or remove husky to let `viberevert hook install` manage `.git/hooks/pre-commit` standalone.
If you want vibe-revert to gate commits while keeping husky, add this line to your husky pre-commit:
  viberevert check --staged
```

**`LefthookDetectedError`** (install, lefthook only; `<signal>` in "lefthook.yml" | "lefthook.yaml" | ".lefthook.yml" | ".lefthook.yaml" | "lefthook-local.yml" | "package.json `lefthook` in devDependencies" | "package.json `lefthook` in dependencies"):
```
Detected lefthook configuration (<signal>). vibe-revert does not install into lefthook-managed hooks in v0.7.0.
Manage your pre-commit through lefthook directly, or remove lefthook to let `viberevert hook install` manage `.git/hooks/pre-commit` standalone.
If you want vibe-revert to gate commits while keeping lefthook, add `viberevert check --staged` to your lefthook.yml pre-commit commands.
```

**`HookManagersDetectedError`** (both detected): emit the `HuskyDetectedError` copy above, then a blank line, then the `LefthookDetectedError` copy above. Both `<signal>` slots filled with each manager's first-match signal per the precedence lists in the "Detection signals" section.

**`MalformedPackageJsonError`** (install; `<path>` is the repo-root-relative package.json path; `<message>` is the JSON parser's error message):
```
Failed to parse package.json while checking for hook managers at <path>: <message>.
Refusing to install the hook because we cannot verify whether husky or lefthook is configured. Fix the JSON and re-run.
```

**`BackupCollisionError`** (install --force when the computed backup path already exists):
```
Existing backup file at <backup-path> would be overwritten by this install. Remove or rename it first, then re-run `viberevert hook install --force`.
```

**`IntegrationsRecordsHookConflictError`** (install; M G1b coexistence guard — fires when `.viberevert/integrations.json` already records a `direct-hook` integration; see the Coexistence with `viberevert install` section):
Refusing to run `viberevert hook install` because .viberevert/integrations.json already records a VibeRevert direct-hook integration.

Choose one recovery path:
  - Remove the recorded integration: viberevert uninstall --direct
  - Migrate to Husky: viberevert install --husky --migrate-from-hook-install

See docs/hook-contract.md for the coexistence model.

**`HookNotFoundError`** (default uninstall when `.git/hooks/pre-commit` is absent):
```
No viberevert hook found at <path> (nothing to uninstall).
If <path> exists but is not viberevert-managed, leave it alone -- vibe-revert refuses to remove hooks it did not write.
```

**`HookNotViberevertManagedError`** (default uninstall when file exists but marker missing / non-regular):
```
Pre-commit hook at <path> is not viberevert-managed (missing expected managed-by marker on line 2, or path is not a regular file). Refusing to remove it.
If this is a stale viberevert hook from a future version, remove it manually.
```

**`NoBackupsFoundError`** (uninstall --restore when no valid backup matches `BACKUP_FILE_REGEX`):
```
No backup files found matching `pre-commit.viberevert-backup-*` in <hooks-dir>. Nothing to restore.
```

**`RestoreTargetExistsError`** (uninstall --restore when current pre-commit fails any validate-before-mutate guard: non-viberevert pre-condition, or final metadata-fingerprint mismatch from a concurrent change between the first and second `lstat(hookPath)` — fingerprint = dev + ino + size + mtimeMs + ctimeMs):
```
Cannot restore safely: pre-commit target at <hookPath> is not the same viberevert-managed hook validated earlier, or already exists and is not viberevert-managed. Remove it manually before `viberevert hook uninstall --restore`.
```

**`HookInstallIoError` / `HookUninstallIoError`** (generic I/O wrap; `<op>` in "stat" | "read" | "rename" | "write" | "chmod" | "remove" | "list" | "mkdir"):
```
Failed to <op> at <path>: <fs-error-message>.
```

**`HookManagerIoError`** (non-ENOENT lstat/readFile failure inside `hook-managers.ts`; same shape as the generic I/O wrap; `<op>` in "stat" | "read"):
```
Failed to <op> at <path>: <fs-error-message>.
```

### Success stdout (exit 0)

**Clean install:**
```
Wrote viberevert pre-commit hook at <path>.
The hook runs `viberevert check --staged` on every commit; vibe-revert's `risk.block_on` threshold (default: critical) determines what aborts the commit.
To bypass this hook for a single commit, use `git commit --no-verify`.
```

**Re-install, byte-identical AND executable (Unix) / byte-identical (Windows):**
```
VibeRevert pre-commit hook already installed at <path> (byte-identical to current template; no changes needed).
```

**Re-install, byte-identical AND non-executable (Unix only):**
```
VibeRevert pre-commit hook already installed at <path> (byte-identical to current template; executable permissions refreshed).
```

**Re-install, bytes differ:**
```
VibeRevert pre-commit hook updated at <path> (existing managed hook refreshed to current template).
```

**Default uninstall:**
```
Removed viberevert pre-commit hook at <path>.
```

**Uninstall --restore:**
```
Restored backup at <backup-path> to <hookPath> (most recent viberevert backup).
```

---

## License

Apache-2.0. See the repository `LICENSE` and `NOTICE` files.
