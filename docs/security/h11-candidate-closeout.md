# H11 candidate closeout

Immutable source identity and a bounded digest of the built outputs for the packages carrying
the H11 fixes. This closeout records targeted replay against that candidate; the output digest
is not a full repository attestation. It carries no Stage A / Decision 7 change — it records
that the H11 fixes hold at one current, immutable identity, not the frozen H10 `a8081359`
artifact.

## Candidate identity

- **Source commit:** `366569020d57d3dc3a7d9958351fa2f0e85dd2fd` (`3665690`), on `origin/main`,
  clean working tree.
- **Bounded affected-output identity:** SHA-256 manifest covering the JavaScript and declaration
  outputs under `packages/{adapters,cli-commands,installers}/dist`:
  - files: 194
  - aggregate manifest digest (SHA-256 of the `LC_ALL=C`-sorted per-file `sha256sum` lines):
    `4f5f6453a46651624286a8a881c81eadaa952c0e9c55b764e1e57ed3c7121baf`
  - reproduction shell: Git Bash
  - reproduce: `find packages/adapters/dist packages/cli-commands/dist packages/installers/dist -type f \( -name '*.js' -o -name '*.d.ts' \) | LC_ALL=C sort | xargs sha256sum | sha256sum`
- **Environment:** Windows 10 Pro 10.0.19045 · Node v24.13.1 (x64) · pnpm 10.29.3 · 2026-08-05.

## Build

PowerShell:

```
pnpm build
```

Exit `0` — 11 workspace projects built.

## Targeted replays

Canonical replay evidence is the two exit-`0` invocations below (PowerShell), each a single
line. The five root-compatible suites and the three Windows CLI-build suites are run
separately: the latter's fixtures resolve relative to the package working directory, so they
are run from `packages/cli-commands`.

Five root-compatible suites:

```
pnpm exec vitest run packages/cli-commands/test/cursor-launcher-warning.test.ts packages/adapters/test/adapters/cursor.test.ts packages/installers/test/github-action-end-to-end.test.ts packages/installers/test/json-key-merge-restoration.test.ts packages/installers/test/end-to-end.test.ts
```

Exit `0` — 5 files, 46 passed.

Three Windows CLI-build suites (from the package directory):

```
pnpm -C packages/cli-commands exec vitest run test/doctor-pnpm-shim-windows.test.ts test/run-cmd-shim-windows-red.test.ts test/run-native-resolve-windows.test.ts
```

Exit `0` — 3 files, 6 ordinary passes, 1 `it.fails` tripwire that failed as expected.

**Execution note.** An initial root invocation included all eight paths. Five suites completed
with 46 passing tests, while three Windows CLI-build suites failed during collection because
their fixtures resolve relative to the package working directory (exit `1`). Those three suites
were rerun successfully from `packages/cli-commands`; the five root-compatible suites were then
rerun separately with exit `0`. The collection error was an invocation-context error, not a
test failure.

| # | Finding | Fix commit | Replay file(s) | Result |
|---|---|---|---|---|
| 1 | `run-agent-windows-shim` | H11.2 `0143c89` | `run-native-resolve-windows.test.ts`, `run-cmd-shim-windows-red.test.ts` | native-resolution and gated-error contracts pass; interactive-`.cmd` future-contract tripwire remains expected-fail |
| 2 | `doctor-pnpm` | H11.2 `0143c89` | `doctor-pnpm-shim-windows.test.ts` | pass |
| 3 | `cursor-mcp-windows-shim` | H11.3 `0aa3828` | `adapters/cursor.test.ts` (22), `cursor-launcher-warning.test.ts` (5), `installers/end-to-end.test.ts` (6) | pass |
| 4 | `github-action-reinstall-update` | H11.4 `6b24f78` | `github-action-end-to-end.test.ts` (7) | pass |
| 5 | `uninstall-restoration-gap` | H11.5 `2c768a7` | `json-key-merge-restoration.test.ts` (6) | pass |
| 6 | `rollback-empty-dirs` | H11.6 `430916a` | documentation-contract verification (below) | verified |

Totals: **52 ordinary passes, 0 unexpected failures, and 1 deliberate `it.fails` tripwire that
failed as expected**, across 8 targeted test files.

The `it.fails` tripwire in `run-cmd-shim-windows-red.test.ts` targets **interactive** `.cmd`
launch. It remains in the expected-fail state because Decision 7 is gated (open, not passed);
it flips to passing only if interactive `.cmd` mediation is ever accepted. Its continued
expected-fail is the correct signal that interactive `.cmd` remains gated — this closeout
implies no Decision 7 change.

## Finding #6 — documentation-contract verification (not a test pass)

The empty-directory limitation is stated in both governing documents (line numbers as of
candidate commit `3665690`; later documentation edits may move them):

- `docs/rollback-limitations.md`, under **## Limitations that affect what you get back**
  (lines 64–67): a directory left empty by a rollback removal stays in place because Git does
  not track empty directories; remove leftover empty directories manually if desired.
- `docs/installers-contract.md`, under **### UninstallOutcome** (line 208): removing a file
  VibeRevert created can leave an empty parent directory; parent directories are not pruned
  because the record captures the managed file operation, and an empty directory is not
  evidence that VibeRevert created it.

Classification: documentation-contract verification (contract-consistent), not a code test.

## Disposition

H11 complete. Decision 7 remains open. Core native-router feasibility has been demonstrated;
productionization and formal validation are deferred until after beta. Beta Windows support
remains native direct-spawn, with interactive `.cmd` targets gated.
