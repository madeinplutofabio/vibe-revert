# ADR 0005: Resolve-then-launch command resolution with bounded Windows shim mediation

- Status: Accepted — 2026-07-30
- Implementation status: Command-line mediation (accepted-subset arguments, stdout/stderr,
  exact-target execution, and exit/error distinction) was validated on the recorded bounded
  H11.1 Windows matrix. The automated portion of the original Decision 7 lifecycle gate was
  completed on one bounded Windows host. The manual Stage A matrix has since run:
  `windows-cmd-bounded-v1` is formally ineligible because the first qualifying run on each of
  the four required hosts produced `interactive_delivery: received` but
  `wrapper_completion: batch_prompt_hang` and machine
  `candidate_wrapper_completion: forced_recovery`. Decision 7 remains open, not passed,
  and interactive `.cmd` production wiring in `run` stays blocked. H11.2 native-target
  resolution, native direct-spawn, and one-shot `doctor` mediation are implemented. A separate
  native control-router feasibility result is recorded under Decision 7 below, but no
  implementation decision is made here. Cursor MCP configuration remains pending H11.3.
- Milestone: H11 (dogfood findings/fixes) — decision in H11.1
- Related: [run contract](../run-contract.md); `packages/cli-commands/src/commands/executable-probe.ts` (the existing resolver), `packages/cli-commands/src/commands/run.ts`, `packages/cli-commands/src/commands/doctor.ts`, `packages/adapters/src/adapters/cursor.ts`

## Context

Three H10 dogfood findings belong to the same Windows command-launch compatibility problem
space, although their exact launcher implementations and failure mechanisms are not assumed
to be identical:

- `viberevert run <agent>` passes the bare name to Node's `spawn(..., { shell: false })`. On
  the observed Windows path, this neither located nor launched the package-manager command
  shim correctly: the bare command failed with `ENOENT`, while directly spawning a resolved
  `.cmd` target is not supported as a native executable and produces `EINVAL`.
- `viberevert doctor` probes `pnpm --version` with a bare `spawnSync` (`doctor.ts`), so
  `pnpm` (present only as `pnpm.cmd`) reports "not found".
- The `install --cursor` MCP config emits `{ "command": "viberevert", ... }`; Cursor cannot
  spawn that bare shim on Windows.

The behavior is launcher-specific, not universal. The same bare `viberevert` command is
launched successfully by Claude Code's MCP client and by the git `sh` that runs the generated
pre-commit hook — so the fix must repair the failing launchers without disturbing the
launchers that already work.

A resolver already exists: `createHostExecutablePathResolver()` in `executable-probe.ts`
(built for the G4 shell resolver) resolves a bare name to its exact path via a deterministic
`PATH` + `PATHEXT` scan, without spawning. Its own design note warns that spawning a bare name
lets the OS re-resolve it — the re-resolution footgun (current directory, extension quirks)
this decision closes.

## Decisions

### 1. Resolve before launching, reusing the existing resolver

Internal spawn sites (`run`, `doctor`) resolve `argv[0]` to an exact filesystem path with the
existing `executable-probe` resolver before launching, and launch the resolved path — never
the bare name. This makes Windows extension resolution explicit (a deterministic `PATH` +
`PATHEXT` scan) and removes the OS re-resolution surface. No new resolver is written.

### 2. `run`: direct-spawn native executables; bounded mediation only for `.cmd`

`viberevert run` keeps its locked contract (`shell: false`, verbatim child exit codes, signal
delivery to the child, one guarded top-level invocation — see the run contract).

The launch decision tree is:

```text
bare command
  → resolve through PATH + PATHEXT
  → directly spawnable native executable, including resolved `.exe` / `.com` targets
      → direct spawn with `shell: false`
  → `.cmd` shim
      → controlled Windows shim mediation
      → preserve arguments and child exit status (signals + scoped teardown are gated by Decision 7)
  → unresolved or unsupported target
      → accurate, actionable error
```

Direct spawn is the default; `.cmd` mediation is used only when necessary, as an explicit
argument-controlled Windows command wrapper — not `shell: true` — so it does not turn
arbitrary Windows execution into shell execution. The resolver or launcher helper classifies
the resolved target; it does not assume every non-`.cmd` extension is safe to spawn directly.
Mediation is accepted only once its guarantees are proven (Decision 4).

### 3. `doctor`: weaker one-shot diagnostic mediation

`doctor`'s version probe is a one-shot diagnostic with no long-running signal-forwarding or
process-tree contract. It first resolves the command to an absolute path. A directly
spawnable native target is launched directly.

A resolved `.cmd` target may be invoked through bounded `cmd.exe` mediation, using the
resolved `ComSpec` executable and an explicitly constructed and tested command line. The
implementation must quote the resolved path and fixed `--version` argument correctly,
disable AutoRun processing (`/d`), preserve stdout/stderr capture, and distinguish launch
failure from the probed command's exit status.

Resolution removes PATH re-resolution; it does not eliminate `cmd.exe` quoting concerns.
Those concerns must be covered by focused tests.

### 4. The `.cmd` mediation carries a tested command-line guarantee set (H11.1)

The `.cmd` mediation contract is accepted, but no production caller may use the mediation
implementation until this command-line guarantee suite passes AND the Decision 7 lifecycle
gate is satisfied. The suite exercises a fixture shim whose path and arguments contain spaces
and filesystem-valid shell-sensitive characters, and proves all of:

1. every accepted argument reaches the child string-for-string;
2. rejected input produces no launch plan;
3. tested accepted-subset input does not execute unintended commands;
4. the child's exit code and wrapper-launch failure remain distinguishable;
5. stdout and stderr remain attached;
6. native directly-spawnable targets retain the direct-spawn path;
7. non-Windows behavior remains unchanged.

The argument matrix includes at least: a shim path with spaces and shell-sensitive
characters; empty arguments; arguments ending in backslashes; embedded quotes; `%`, `!`, `&`,
`(`, `)`, `^`, and redirection-like content; and Unicode arguments. The mediation resolves
`ComSpec` rather than assuming `cmd` is on `PATH`, and is verified with delayed expansion
disabled.

If a guarantee cannot be met, `run` surfaces an actionable error rather than launching with
degraded semantics.

Signal delivery, interactive wrapper completion, and scoped process-tree teardown are not
command-line mediation guarantees. They are governed by the separate lifecycle acceptance
gate in Decision 7.

### 5. Generated MCP configuration is treated as a separate launcher context

The Cursor-generated MCP configuration must start VibeRevert on the observed Windows client
without changing the already-working Claude MCP and direct-hook forms.

H11.1 does not yet mandate a concrete emitted command. H11.3 will select the narrowest
configuration supported by Cursor after testing:

- bounded Windows `cmd.exe` mediation;
- a cross-platform executable or launcher entry;
- any platform-specific configuration facility supported by the client.

The selected form must account for repository portability. A host-specific command or
absolute path must not be silently emitted into configuration that is intended to be shared
across operating systems.

The Claude MCP configuration and direct pre-commit hook remain unchanged unless independent
evidence shows that they require modification. Regression tests pin their currently working
forms.

### 6. Node-entry resolution is not the contract

Parsing a `.cmd` shim to find and spawn its underlying Node script is rejected as the general
contract: shim formats differ across npm / pnpm / yarn, package layouts change (Claude's own
`cli.js → bin/claude.exe` move is an example), and not every `.cmd` wraps Node — it would
couple VibeRevert to third-party package internals. It may later be added as an optimization
for specifically recognized shims, but the durable contract is resolve-then-launch with
bounded `.cmd` mediation.

### 7. Lifecycle acceptance is separate from command-line mediation, and gated

Validating argument, output, and exit mediation for the accepted subset does NOT by itself
make `.cmd` mediation eligible for interactive `run`. Runtime lifecycle is a separate
acceptance gate, recorded as four results (mirroring the
[lifecycle runbook](../security/windows-cmd-mediation-lifecycle.md)):

- `interactive_delivery` and `wrapper_completion` — the required real-keyboard,
  inherited-console behavior is verified manually and is not treated as equivalent to a
  synthesized control event in the automated suite;
- `forced_recovery` and `orphan_posture` — established by the H11.1 automated lifecycle
  spike. On one bounded Windows host these were `tree_stopped_sentinel_survived` and
  `descendants_survived_observation_window` respectively; the bounded host result, test
  identity, and full interpretation are recorded in the external dogfood evidence workspace
  at `evidence/findings/finding-h11-windows-cmd-lifecycle-spike.md`.

Interactive `.cmd` mediation is eligible for production wiring in `run` only when
`interactive_delivery: received` and `wrapper_completion: clean_exit`; any other outcome is
blocked by default and can be accepted only by an amendment to this ADR that defines the
interaction and cleanup contract.

Two boundaries are load-bearing:

- **Forced PID-tree cleanup (`taskkill /T`) is emergency behavior, not graceful `run`
  semantics** — a recovery property, never the interactive interrupt path.
- **Observed descendant survival after wrapper-only termination describes the current
  posture, not a universal Windows guarantee** — it may vary with a future wrapper, process
  flags, terminal host, or runtime.

**Interactive Ctrl+C behavior and wrapper completion remain subject to manual
inherited-console verification** and were not concluded at the time of this decision (see the
2026-08-04 update below). If they do not reach `received` + `clean_exit`, `.cmd` interactive
`run` stays blocked, directly spawnable native executables remain preferred and supported
(modern Claude Code is covered), and full support may require an explicit Windows
lifecycle-ownership mechanism, such as a process-group helper, native control router, or
Job-Object-backed launcher.

**Update (2026-08-04) — recorded results.** The manual Stage A matrix has run.
`windows-cmd-bounded-v1` is formally ineligible: the first qualifying run on each of the
four required hosts produced `interactive_delivery: received` but
`wrapper_completion: batch_prompt_hang` and machine
`candidate_wrapper_completion: forced_recovery`—never `clean_exit`. A `& call set`
continuation candidate did not establish viable mediation in either tested `.cmd`-target
topology and is not being pursued further.

A separate, disposable native control-router feasibility spike—one host, one representative
launcher topology, and not attested—demonstrated core feasibility for a distinct mechanism:
debug only `cmd.exe`, handle its `DBG_CONTROL_C`, and leave the native descendant undebugged.
In that run, real keyboard Ctrl+C reached the native descendant, `cmd.exe` did not display its
batch-termination prompt, the processes returned autonomously, and `cmd.exe` propagated exit
`130`.

No implementation decision is made here. Decision 7 remains open: interactive `.cmd`
mediation stays blocked and native direct-spawn remains the supported `run` path. Any positive
support decision is deferred until after beta and requires a new strategy identity, security
review, compatibility work across hosts, and a formal attested matrix, followed by a future
amendment to this ADR. Results, digests, and the raw transcript are recorded in the
[lifecycle runbook](../security/windows-cmd-mediation-lifecycle.md) under
Recorded results — 2026-08-04.

## Alternatives considered

- **Resolve + direct-spawn only, with an improved error for `.cmd`.** Fixes agents that ship a
  native executable (modern Claude Code) but knowingly leaves `.cmd`-only agents (`cursor`,
  `codex`, `npx`) unlaunchable — it would not close the high-severity `run` finding.
- **Wrap every `.cmd` in `cmd /c` (general shell mediation).** Too loose: it accepts
  regressions to the run contract (signal propagation, process-tree ownership, quoting, exit
  semantics) rather than requiring them to be solved and bounded.
- **A fixed Windows `cmd /c` command in the Cursor config**
  (`{ "command": "cmd", "args": ["/c", "viberevert", "mcp", "serve"] }`). A candidate for the
  Cursor launcher (Decision 5 / H11.3), not yet selected: a host-specific command written into
  shareable repository configuration would fail for macOS/Linux collaborators, so H11.3 weighs
  it against a cross-platform entry and any client-supported platform-specific facility.
- **Node-entry resolution as the contract.** Rejected as in Decision 6 (format-specific, brittle).
- **`shell: true`.** Rejected: turns all Windows execution into shell execution and reopens the
  injection surface `shell: false` was chosen to avoid.

## Consequences

- `run <agent>` launches directly spawnable native agents through direct spawn. Interactive
  `.cmd` targets remain gated and fail with an accurate, actionable error rather than degraded
  semantics. Future `.cmd` launcher support may be added only under a new strategy that
  satisfies both the command-line guarantee set and the Decision 7 lifecycle acceptance gate.
- `doctor` will report `.cmd`-only tools correctly.
- The Cursor MCP integration will be made launchable on the observed Windows client (mechanism
  selected in H11.3), while the working Claude MCP and pre-commit-hook launch paths stay
  unchanged and regression-pinned.
- `run`'s `.cmd` path carries a documented, tested guarantee set; if a guarantee cannot be met,
  `run` surfaces an actionable error rather than launching with degraded semantics.
- Non-Windows behavior is unchanged: resolution returns the same POSIX path and the
  direct-spawn path is used.
- The decision reuses the existing `executable-probe` resolver rather than adding a second
  resolution mechanism.
- Command-line mediation is validated for the bounded accepted subset, but
  `windows-cmd-bounded-v1` is lifecycle-ineligible. Interactive `.cmd` execution remains gated
  until a future strategy satisfies Decision 7; directly spawnable native executables remain
  the supported Windows `run` path.
