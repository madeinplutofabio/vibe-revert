# Security & quality regression ledger

Tracks confirmed product findings across the safety/quality surface: what failed, who it
affects, the regression test that pins it, whether a contract changed, and the release that
resolves it. Entries are intentionally terse and carry **no exploit-enabling detail before a
fix ships**; reproduction and full analysis live in the linked evidence.

This first version records the three Windows launcher findings in the active H11.1 unit; H11.4
added `github-action-reinstall-update`, H11.5 added `uninstall-restoration-gap`, and H11.6 added
`rollback-empty-dirs` (an H11 triage observation classified contract-consistent, not a defect).
All six H10 findings are now recorded.

Fields per entry: `id` · `surface` · `severity` · `status` · `failure-class` ·
`user-impact` · `test-added` · `contract-changed` · `fixed-release` · `fixed-commit` ·
`disposition` · `evidence`.

Status vocabulary: `open` (confirmed, not yet resolved in a released build) · `fixed`
(resolved in the named release) · `blocked` (a resolved path exists but is gated on a
separate, unsatisfied acceptance). Currently `doctor-pnpm`, `cursor-mcp-windows-shim`,
`github-action-reinstall-update`, and `uninstall-restoration-gap` are `fixed`;
`rollback-empty-dirs` is closed as contract-consistent through documentation rather than a code
change; `run-agent-windows-shim` remains `open` (partially resolved; interactive `.cmd` gated by
ADR 0005 Decision 7).

Evidence outside the source tree lives in the external dogfood evidence workspace
(`vr-dogfood/evidence/…`).

The H11 candidate build identity (commit `3665690`) and the targeted replay of all six
findings against it are recorded in
[`h11-candidate-closeout.md`](./h11-candidate-closeout.md).

## Summary

| id | surface | severity | status | fixed-release | fixed-commit |
|---|---|---|---|---|---|
| `run-agent-windows-shim` | `run <agent>` internal spawn | high | open — native resolution + truthful `.cmd` gating landed; interactive `.cmd` still blocked by ADR 0005 Decision 7 | — | — |
| `doctor-pnpm` | `doctor` version probe | low | fixed | pending release | `0143c89a19081cfe392b84916727f3a7ff059033` |
| `cursor-mcp-windows-shim` | `install --cursor` generated MCP config | high (Cursor) | fixed | pending release | `0aa382851ba7f87ce3cbe9a632d0e951ef037acb` |
| `github-action-reinstall-update` | `install --github-action` reinstall/update | medium | fixed | pending release | `6b24f7870fe3d10c9e013722cc51e2140ced0117` |
| `uninstall-restoration-gap` | `uninstall` json-key-merge MCP config | low | fixed | pending release | `2c768a7750e0a5baa14c356efb18ddf6476e728e` |
| `rollback-empty-dirs` | `rollback`/`uninstall` leftover empty directories | low | fixed | pending release | `430916ace44dabcbc967a725ac5de7cdad6cd284` |

## `run-agent-windows-shim`

- **surface:** `viberevert run <agent>` internal Node spawn (`packages/cli-commands/src/commands/run.ts`).
- **severity:** high
- **status:** open
- **failure-class:** Windows shim launch failure — `spawn(…, { shell: false })` cannot launch a
  command exposed only as a `.cmd`/`.ps1` shim (bare name → `ENOENT`; spawning the resolved
  `.cmd` directly → `EINVAL`).
- **user-impact:** the documented `viberevert run claude` failed with "Command not found"
  (exit 127) although the agent was installed and on `PATH`. The same launch path can affect
  agents exposed only through Windows command shims. H11.1 has validated bounded `.cmd`
  mediation; `.ps1` and other script forms remain unsupported unless separately designed and
  tested.
- **test-added:** command-line mediation builder + suites green
  (`packages/cli-commands/test/command-launcher.test.ts`,
  `…/command-launcher-windows-live.test.ts`, `…/command-launcher-lifecycle-live.test.ts`).
  H11.2 added `run` regressions: native PATH resolution
  (`…/run-native-resolve-windows.test.ts`), the `.cmd` gated-rejection GREEN test and the
  updated D102 `.cmd` case (`…/run-cmd-shim-windows-red.test.ts`, `…/run-command.test.ts`), and
  the interactive-`.cmd`-launch `it.fails` tripwire that flips when Decision 7 opens.
- **contract-changed:** no public CLI or persisted-schema change; internal command resolution
  and launch semantics are newly specified by ADR 0005 Decisions 1–2 and gated by Decision 7.
- **fixed-release:** —
- **disposition:** partially resolved in H11.2 (`0143c89`): `run` resolves the exact target and
  direct-spawns native executables, and rejects a resolved `.cmd` with a truthful
  Decision-7-gated message instead of a misleading "Command not found". Native executable
  mediation is supported; interactive `.cmd` mediation remains gated (ADR 0005 Decision 7,
  which is open, not passed). Update (2026-08-04): the Stage A manual Ctrl+C matrix ran, and
  `windows-cmd-bounded-v1` is formally ineligible. The first qualifying run on each of the four
  required hosts produced the same blocking outcome: `Terminate batch job (Y/N)?`,
  `batch_prompt_hang`, and `forced_recovery`. In follow-up throwaway probes, the `& call set`
  continuation did not establish viable mediation in either tested `.cmd`-target topology—an
  outer wrapper calling the target `.cmd`, or a direct top-level `/c` compound command calling
  the target `.cmd`—and that continuation candidate is not being pursued further. A separate,
  disposable native debug-router feasibility probe (one host, one representative launcher
  topology, not attested) successfully preserved real Ctrl+C delivery to a native descendant
  while suppressing `cmd.exe`'s batch prompt and propagating exit `130`. Production
  implementation, a new strategy identity, and formal validation are deferred until after beta.
  Directly-spawnable native executables (modern Claude Code) remain the supported path.
- **evidence:** `vr-dogfood/evidence/findings/finding-run-agent-windows-shim.md`;
  lifecycle `vr-dogfood/evidence/findings/finding-h11-windows-cmd-lifecycle-spike.md`;
  Stage A matrix result and native-router feasibility record in
  `docs/security/windows-cmd-mediation-lifecycle.md` under
  Recorded results — 2026-08-04.

## `doctor-pnpm`

- **surface:** `viberevert doctor` version probe
  (`packages/cli-commands/src/commands/doctor.ts`, `probeVersion()`).
- **severity:** low
- **status:** fixed
- **failure-class:** bare `spawnSync("pnpm", …)` without shim resolution reports
  `pnpm: not found` on Windows even when pnpm is installed and on `PATH`.
- **user-impact:** informational only; `doctor` still exits 0 and only the `pnpm` line is wrong.
- **test-added:** `packages/cli-commands/test/doctor-pnpm-shim-windows.test.ts` — GREEN: baseline
  shim validity + real DoctorCommand reports the PATH-resolved `pnpm.cmd` version (not
  `not found`).
- **contract-changed:** no public CLI or persisted-schema change; internal executable-probe
  semantics are specified by ADR 0005 Decision 3.
- **fixed-release:** pending release
- **fixed-commit:** `0143c89a19081cfe392b84916727f3a7ff059033`
- **disposition:** fixed in H11.2 — `doctor`'s `probeVersion` resolves the command, then
  direct-spawns a native target or probes a resolved `.cmd` through bounded one-shot `cmd.exe`
  mediation (ADR 0005 Decision 3, no lifecycle contract). Independent of the interactive `run`
  gate.
- **evidence:** `vr-dogfood/evidence/artifact/finding-doctor-pnpm.md`.

## `cursor-mcp-windows-shim`

- **surface:** `viberevert install --cursor` generated MCP configuration (`.cursor/mcp.json`);
  the spawn is owned by the Cursor client, not by VibeRevert.
- **severity:** high (Cursor)
- **status:** fixed
- **failure-class:** the emitted `{ "command": "viberevert", … }` bare shim is not spawnable by
  Cursor on the observed Windows client.
- **user-impact:** Cursor cannot start the VibeRevert MCP server on Windows.
- **test-added:** GREEN across four H11.3 suites, with the existing H11.1 cross-context protect
  guard also remaining GREEN. `packages/adapters/test/adapters/cursor.test.ts` pins
  `buildCursorMcpLaunchValue` (win32 → `cmd /c viberevert mcp serve`; linux/darwin → bare
  `viberevert mcp serve`) and that the adapter plan value derives from it.
  `packages/cli-commands/test/cursor-launcher-warning.test.ts` pins the advisory emitter's exact
  two-line text + non-throwing contract and the cursor-plus-win32-only predicate.
  `packages/cli-commands/test/install.test.ts` pins that a successful Windows Cursor apply emits
  the advisory (noop and non-cursor applies do not).
  `packages/installers/test/end-to-end.test.ts` pins the end-to-end cursor scenarios against the
  value derived from the adapter's own plan. The already-working Claude MCP and direct
  pre-commit-hook forms are pinned unchanged by
  `packages/adapters/test/adapters/h11-windows-launcher-protect.test.ts` (H11.1).
- **contract-changed:** generated-output change to `.cursor/mcp.json` (ADR 0005 Decision 5): on
  Windows the VibeRevert entry now emits
  `{ "command": "cmd", "args": ["/c", "viberevert", "mcp", "serve"] }`; on other platforms the
  existing bare `viberevert` form is unchanged.
- **fixed-release:** pending release
- **fixed-commit:** `0aa382851ba7f87ce3cbe9a632d0e951ef037acb`
- **disposition:** fixed in H11.3 (`0aa3828`): the Cursor adapter emits the verified
  `cmd /c viberevert mcp serve` launcher on Windows and preserves the bare `viberevert` form on
  other platforms, and `install --cursor` surfaces a non-blocking portability advisory after a
  successful Windows Cursor apply. This remains a separate client-owned launcher context: the
  consuming Cursor client owns the spawn and the installer only emits configuration data, so the
  `run` interactive gate (Decision 7) does not decide this mechanism. The working Claude MCP
  configuration and the direct pre-commit hook are deliberately left unchanged.
- **evidence:** `vr-dogfood/evidence/findings/finding-cursor-mcp-windows-shim.md`.

## `github-action-reinstall-update`

- **surface:** `viberevert install --github-action` reinstall/update
  (`packages/adapters/src/adapters/github-action.ts`, `plan()`).
- **severity:** medium
- **status:** fixed
- **failure-class:** the generated workflow advertises "rerun to update", but the adapter's
  recognized-workflow branch emitted `sentinel-block-replace` while the first install recorded
  `write-new`. The engine classifier refuses the cross-kind record-vs-plan transition as
  `integrations-record-kind-mismatch`, which `--force-reinstall` cannot override.
- **user-impact:** the advertised one-command update was unreachable; users had to remove the
  existing installation state before installing again. No data loss.
- **test-added:** GREEN. `packages/installers/test/github-action-end-to-end.test.ts` — the H11.4
  lifecycle acceptance suite: first install plans and records `write-new`; same-input reinstall
  is a noop; a changed `ctx.cliVersion` is a safe update that retains `write-new`; uninstall
  deletes the workflow file and restores the absent state; a foreign workflow is refused; manual
  drift is refused without `--force`; and forced replacement of a drifted recognized workflow
  follows `write-new` semantics with no backup. `packages/adapters/test/adapters/github-action.test.ts`
  pins the recognized-workflow branch to a `write-new` op carrying the full wrapped content.
- **contract-changed:** no persisted-schema change. The adapter's recognized-workflow branch now
  emits `write-new` (whole-file) instead of `sentinel-block-replace`;
  `.github/workflows/viberevert.yml` is documented as wholly VibeRevert-owned (sentinel markers
  identify a recognized workflow, not a user-editable region). `sentinel-block-replace` remains
  engine-supported but is no longer emitted by any shipped adapter.
- **fixed-release:** pending release
- **fixed-commit:** `6b24f7870fe3d10c9e013722cc51e2140ced0117`
- **disposition:** fixed in H11.4 (`6b24f78`): install and reinstall share one durable op-kind
  (`write-new`), so the advertised rerun-to-update path is reachable — the classifier decides
  from the full-file SHA whether the result is a noop, a safe update, or a drift refusal.
  Uninstall reverses `write-new` by deleting the file (restores the absent state); a manual edit
  is drift and is refused without `--force-reinstall`, never silently overwritten. A pre-existing
  foreign workflow is still refused (`non-vr-workflow-present`) and `--force-reinstall` still
  routes through `backup-and-write`. No engine, record-schema, or uninstall change was required.
- **evidence:** `vr-dogfood/evidence/findings/finding-github-action-reinstall-update.md`.

## `uninstall-restoration-gap`

- **surface:** `viberevert install`/`uninstall` for json-key-merge MCP config adapters
  (`packages/installers/src/engine-uninstall.ts`, `reverse-json-key-merge`); Cursor
  (`.cursor/mcp.json`) and Claude (`.mcp.json`).
- **severity:** low
- **status:** fixed
- **failure-class:** a json-key-merge adapter that created its config file from absence left an
  empty `{ "mcpServers": {} }` scaffold after uninstall -- `reverse-json-key-merge` deleted the
  managed key but never pruned empty ancestors or unlinked, and the record stored no provenance
  to distinguish "created from absence" from "merged into a user's file".
- **user-impact:** low operational impact; uninstall exits 0 and reverses the managed record, but
  leaves an empty config file and its created directory instead of restoring the pre-install
  absence. No user-authored data is lost.
- **test-added:** GREEN. `packages/installers/test/json-key-merge-restoration.test.ts` -- the
  create-from-absence cases for Cursor and Claude assert uninstall unlinks the file and reports
  it under `receipt.filesRemoved`; the preserve cases (a pre-existing user file, a post-install
  user addition, a user-added empty object, and a legacy record without the marker) assert
  write-back and `receipt.filesRestored`. `packages/installers/test/integrations-schema.test.ts`
  pins the marker's per-kind discipline (accepted on json-key-merge, rejected on every other kind
  and on the literal `false`).
- **contract-changed:** additive persisted-record field within `schemaVersion 1`
  (`targetWasAbsentBeforeApply`, a positive-only `true`-or-absent marker restricted to
  json-key-merge records). No version bump; missing means "unknown" and never permits uninstall
  to consider restoration to absence, so legacy/dev records stay conservative.
- **fixed-release:** pending release
- **fixed-commit:** `2c768a7750e0a5baa14c356efb18ddf6476e728e`
- **disposition:** fixed in H11.5 (`2c768a7`): apply records `targetWasAbsentBeforeApply` when the
  target was absent before the merge, and uninstall unlinks the file only when removing the
  managed key leaves the empty-ancestor scaffold under the engine's canonical JSON digest.
  Merges into pre-existing files, post-install user additions (including empty objects), and
  legacy records without the marker are preserved via the existing write-back path. FILE
  restoration only; parent-directory cleanup remains `rollback-empty-dirs` (H11.6).
- **evidence:** `vr-dogfood/evidence/findings/finding-uninstall-restoration-gap.md`.

## `rollback-empty-dirs`

- **surface:** `viberevert rollback --apply` (`packages/git/`) and installer `uninstall`
  (`packages/installers/`): a directory left empty after a removed file.
- **severity:** low
- **status:** fixed (documentation resolution; contract-consistent H11 triage observation, not a
  code defect)
- **failure-class:** none. Rollback and uninstall may remove the last managed file from a
  directory without removing that directory. An empty directory such as `app/api/payments/` after
  rollback or `.cursor/` after uninstall can therefore remain on disk.
- **user-impact:** cosmetic. Rollback restores the recorded file content and Git index, and
  uninstall reverses the managed file record, but an empty directory may remain visible on the
  filesystem. It is outside the documented restoration contract. No user-authored data is lost.
- **test-added:** none. The behavior is contract-consistent and unchanged; H11.6 documents it
  (`docs/rollback-limitations.md`, `docs/installers-contract.md`) rather than altering it. The
  H11.5 create-case restoration suite already asserts the file is unlinked; the now-empty
  directory is intentionally not asserted.
- **contract-changed:** none (behavior unchanged; documentation only). The contracts are
  clarified: rollback restores recorded file content and the Git index, not the exact directory
  tree; uninstall reverses recorded managed-file effects and does not infer ownership of parent
  directories.
- **fixed-release:** pending release
- **fixed-commit:** `430916ace44dabcbc967a725ac5de7cdad6cd284`
- **disposition:** contract-consistent, not a defect (H11 triage observation, low). Rollback
  correctness passed: recorded file content and Git index state were restored. Exact directory
  shape is outside that contract because the Git-visible baseline does not represent empty
  directories. Installer uninstall separately lacks evidence that a parent directory was created
  by VibeRevert. H11.6 documents both contracts and defers directory pruning as an enhancement.
  Safe pruning would require explicit directory-creation provenance, protected path boundaries,
  and an empty-directory check; emptiness alone is not ownership evidence. No schema or engine
  change is made.
- **evidence:** `vr-dogfood/evidence/findings/triage-rollback-empty-dirs.md`.
