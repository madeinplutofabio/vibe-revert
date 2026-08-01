# Security & quality regression ledger

Tracks confirmed product findings across the safety/quality surface: what failed, who it
affects, the regression test that pins it, whether a contract changed, and the release that
resolves it. Entries are intentionally terse and carry **no exploit-enabling detail before a
fix ships**; reproduction and full analysis live in the linked evidence.

This first version records the three Windows launcher findings in the active H11.1 unit. The
remaining confirmed H10 findings (`github-action-reinstall-update`, `uninstall-restoration-gap`,
and `rollback-empty-dirs`) will be added during H11 triage before their final dispositions are
closed.

Fields per entry: `id` · `surface` · `severity` · `status` · `failure-class` ·
`user-impact` · `test-added` · `contract-changed` · `fixed-release` · `fixed-commit` ·
`disposition` · `evidence`.

Status vocabulary: `open` (confirmed, not yet resolved in a released build) · `fixed`
(resolved in the named release) · `blocked` (a resolved path exists but is gated on a
separate, unsatisfied acceptance). Currently `doctor-pnpm` is `fixed`; `run-agent-windows-shim`
and `cursor-mcp-windows-shim` remain `open`.

Evidence outside the source tree lives in the external dogfood evidence workspace
(`vr-dogfood/evidence/…`).

## Summary

| id | surface | severity | status | fixed-release | fixed-commit |
|---|---|---|---|---|---|
| `run-agent-windows-shim` | `run <agent>` internal spawn | high | open — native resolution + truthful `.cmd` gating landed; interactive `.cmd` still blocked by ADR 0005 Decision 7 | — | — |
| `doctor-pnpm` | `doctor` version probe | low | fixed | pending release | `0143c89a19081cfe392b84916727f3a7ff059033` |
| `cursor-mcp-windows-shim` | `install --cursor` generated MCP config | high (Cursor) | open — separate client-owned context; mechanism selected in H11.3 | — | — |

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
- **disposition:** partially resolved in H11.2 (`0143c89`): `run` now resolves the exact target
  and direct-spawns native executables, and rejects a resolved `.cmd` with a truthful
  Decision-7-gated message instead of a misleading "Command not found". The remaining open
  portion is interactive `.cmd` execution: the manual gate remains open; `interactive_delivery`
  and `wrapper_completion` have not yet been run (ADR 0005 Decision 7). Directly-spawnable native
  executables (modern Claude Code) are the supported path.
- **evidence:** `vr-dogfood/evidence/findings/finding-run-agent-windows-shim.md`;
  lifecycle `vr-dogfood/evidence/findings/finding-h11-windows-cmd-lifecycle-spike.md`.

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
- **status:** open
- **failure-class:** the emitted `{ "command": "viberevert", … }` bare shim is not spawnable by
  Cursor on the observed Windows client.
- **user-impact:** Cursor cannot start the VibeRevert MCP server on Windows.
- **test-added:** pending H11.3 (Cursor config mechanism selection). Protect-guard tests pinning
  the already-working Claude MCP + direct pre-commit-hook forms are pending (later H11.1 unit).
- **contract-changed:** generated-output change to `.cursor/mcp.json` (mechanism selected in
  H11.3, ADR 0005 Decision 5).
- **fixed-release:** —
- **disposition:** separate client-owned launcher context, unaffected by the `run` lifecycle
  verdict; the consuming client owns the spawn and the installer only emits configuration data,
  so the `run` interactive gate does not decide this mechanism; the working Claude MCP
  configuration is left unchanged.
- **evidence:** `vr-dogfood/evidence/findings/finding-cursor-mcp-windows-shim.md`.
