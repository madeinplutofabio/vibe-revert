# Decision 7 Stage A — operator runbook

Operator tooling to run the **manual, real-keyboard Ctrl+C matrix** that ADR 0005
Decision 7 requires before interactive `.cmd` mediation can be wired into
`viberevert run`. This runbook is the operating procedure for the scripts in this
directory; it extends — and does not replace —
[`docs/security/windows-cmd-mediation-lifecycle.md`](../../docs/security/windows-cmd-mediation-lifecycle.md)
(the contract) and [ADR 0005](../../docs/adr/0005-windows-command-resolution-and-launch.md).

**This is operator tooling, not product code and not a Vitest test.** It is
Windows-only. It never wires `.cmd` mediation into `run`; it only observes, on a real
inherited console, whether a keyboard Ctrl+C reaches a fixture agent under the bounded
`windows-cmd-bounded-v1` plan and whether `cmd.exe` completes cleanly.

> **Do not begin the real matrix until `summarize-matrix.mjs` and its tests are
> complete.** The reset, consecutiveness, attestation-consistency and operator-schema
> rules are enforced by the summarizer, not by any single run.

## Files

| File | Role |
|---|---|
| `fixture-agent.mjs` | Interactive agent fixture. Arms SIGINT, prints `AGENT-READY`, heartbeats, and on Ctrl+C writes a token-bound `sigint` record and exits 130. Config via env only. |
| `decision7-lib.mjs` | Deterministic validation/serialization + bounded filesystem primitives shared by the harness and summarizer. |
| `operator-harness.mjs` | The `attest` / `preflight` / `run` subcommands. Owns spawning, the SIGINT handler, classification, and sealing. |
| `summarize-matrix.mjs` | (follow-up) Non-interactive matrix summarizer — the authority on eligibility across runs. |
| `README.md` | This runbook. |

## Prerequisites

- Windows with a **real interactive console** (`run` refuses when stdin/stdout/stderr
  are not all TTYs unless `--allow-noninteractive`, which forces a non-eligible run).
- A **clean working tree at one immutable commit**. `attest`, `preflight` and `run`
  refuse a dirty tree unless `--allow-dirty` (diagnostic, non-eligible).
- `pnpm` and `git` available.
- `%SystemRoot%\System32\where.exe` must be present. Native `taskkill.exe` is required
  to recover a surviving process; if it is unavailable when cleanup is needed, the run
  cannot seal.

## The evidence-identity model

Decision 7 must be evaluated against **one built identity**. `attest` runs a fresh
focused build through bounded ComSpec mediation and writes a **write-once build
bundle** capturing the git commit, Node/pnpm versions, ComSpec/pnpm-shim digests, repo
real-path identity, source/compiled/fixture/harness/library hashes, and the build
stdout/stderr artifacts. Every `run` and `preflight` re-verifies that bundle and
refuses if anything drifted. All runs in a matrix case must share the same
`attestationDigest`; `summarize-matrix.mjs` must reject a case that mixes identities.

## Path conventions

The examples below use:

- `<evidence-root>` — the matrix evidence root. Pass it to **every** subcommand via
  `--evidence-dir` so run evidence never lands in the default in-repo scratch dir.
- `<attestation-dir>` — the build bundle leaf,
  `<evidence-root>/decision7-build-attestation`.

Commands are shown for **PowerShell** (backtick continuation). In Command Prompt (the
`cmd` shell-host cases) keep each command on one line or use `^` for continuation —
never Bash `\`.

## 1. Attest (once per matrix identity)

```powershell
node scripts/decision7/operator-harness.mjs attest `
  --evidence-dir <evidence-root>
```

- Writes `<attestation-dir>` (override the leaf with `--attestation-dir`). Write-once —
  refuses if it already exists.
- Prints the `attestationDigest` and bundle path on success. **Record the digest.**
- The sealed build-output artifacts exist **only for a successful attestation**; a
  timed-out, buffer-exceeded, or truncated build produces no attestation.
- `--allow-dirty` produces a diagnostic (non-eligible) attestation from a dirty tree.

## 2. Preflight (dry; per terminal, before repetition 1)

```powershell
node scripts/decision7/operator-harness.mjs preflight `
  --attestation-dir <attestation-dir> `
  --evidence-dir <evidence-root> `
  --terminal-host windows-terminal --shell-host powershell `
  --repetition 1 --host-label "Windows Terminal 1.x / PowerShell 7.x"
```

Runs the full non-spawn validation (attestation freshness + environment/machine
identity, ComSpec, pnpm shim, generated-wrapper safety, exact plan shape, sibling
scan) and exits **without creating a bundle or spawning a child**. It **refuses**
(exit 2) anything `run` would refuse: malformed sibling evidence, a conflicting
attestation digest, identity inconsistency under a matching digest, or a repetition
leaf collision (unless `--new-attempt`). Use it to check each terminal host before
committing to repetition 1.

## 3. Run (the interactive experiment)

Open the **actual terminal host** for the case (e.g. Windows Terminal running
PowerShell), then:

```powershell
node scripts/decision7/operator-harness.mjs run `
  --attestation-dir <attestation-dir> `
  --evidence-dir <evidence-root> `
  --terminal-host windows-terminal --shell-host powershell `
  --repetition 1 --host-label "Windows Terminal 1.x / PowerShell 7.x"
```

Procedure (the harness prints prompts):

1. Confirm at the prompt by typing the `matrixCaseId` (e.g. `windows-terminal__powershell`).
2. Wait for `Fixture READY (agent pid …)`.
3. **Press Ctrl+C exactly once.** Do **not** press any other key for the observation
   window (default 10 s).
4. Note whether `AGENT-INTERRUPTED` appears, whether `Terminate batch job (Y/N)?`
   appears, and whether the wrapper exits without input.
5. After the run, fill the operator templates (below).

Optional flags: `--observation-seconds` (10), `--operator-response-seconds` (60),
`--readiness-seconds` (15), `--heartbeat-ms` (500), `--new-attempt` (preserve a prior
attempt at the same repetition), `--allow-dirty` / `--allow-noninteractive`
(diagnostic, non-eligible).

**Diagnostic runs:** a diagnostic `run` must use a **separate** diagnostic
`--evidence-dir` — never the real matrix evidence root — to keep diagnostic debris out
of the summarizer's namespace. Prefer `preflight` when no child execution is needed.

## Required terminal-host matrix

Each case is `--terminal-host` × `--shell-host`. The initially required cases:

| matrixCaseId | terminal host | shell host |
|---|---|---|
| `windows-terminal__powershell` | Windows Terminal | PowerShell |
| `windows-terminal__cmd` | Windows Terminal | Command Prompt |
| `conhost__cmd` | classic conhost | Command Prompt |
| `vscode-integrated__powershell` | VS Code integrated terminal | PowerShell |

Support claims stay scoped to configurations actually verified. The required set is
recorded (versioned) in `MATRIX_DEFINITION`; adding hosts is a matrix-definition
version bump, not a silent change.

## What the operator fills

The harness writes machine-authoritative facts to `raw/result.machine.json` (never
edit it). The operator completes two files under `operator/`:

- `result.operator.yaml` — `name`, `completed_at` (millisecond-precision UTC, e.g.
  `2026-08-04T13:45:07.123Z`, and not earlier than the final recorded harness event),
  and the **console-observed** verdicts. `wrapper_completion_confirmed` uses the runbook
  vocabulary: `clean_exit | batch_prompt_then_exit | batch_prompt_hang |
  wrapper_hang_without_prompt | indeterminate`. This is **distinct** from the machine
  `candidate_wrapper_completion`, which the harness derives from process lifecycle.
- `console-observation.txt` — the console output the harness could **not** capture
  (stdio is inherited), the batch-prompt observation, and a screenshot/terminal
  capture reference (redact user paths).

Every `operator:` field must hold a **non-empty** value. When a free-text field has
nothing to report, enter `none` — a blank value or a leftover `TO_BE_FILLED` makes the
run non-eligible in `summarize-matrix.mjs`.

## Pass and fail rules

A single **run counts toward eligibility** only when all of:

- the bundle **sealed** (a verified `manifest.sha256`, harness exit `0`), i.e.
  `rawEvidenceComplete: true` / `integrity_status: complete`;
- `experiment_validity: valid`;
- `event_protocol_valid: true`;
- `interactive_delivery: received`;
- machine `candidate_wrapper_completion: clean_exit`;
- operator `wrapper_completion_confirmed: clean_exit` with `batch_prompt_observed: no`;
- `eligibility_constraints.eligibility_constraints_satisfied: true` (no diagnostic override).

A **matrix case is eligible** only after **three consecutive** eligible runs
(repetitions 1, 2, 3) sharing the same commit, `attestationDigest`, Node version,
ComSpec digest, harness implementation version, and host classification, with **no**
invalid/blocked/indeterminate attempt between them.

**Reset rule:** any blocked, invalid, indeterminate, or non-sealed attempt resets that
case's consecutive sequence. Failed attempts are preserved (write-once); re-run with
`--new-attempt` — never overwrite. `summarize-matrix.mjs` **must** apply this rule
deterministically over the time-ordered attempts; do not hand-pick three successes
from a noisy series, and do not begin the real matrix until that implementation and its
tests exist.

## Evidence bundle layout

A repetition:

```text
<evidence-root>/
  <matrixCaseId>/
    repetition-<n>/
      manifest.sha256               # covers raw/** ; a verified manifest == "sealed"
      raw/                          # immutable machine evidence
        metadata.json
        fixture-events.jsonl        # token-bound; carries the token (not secret post-run)
        harness-events.jsonl
        result.machine.json
        cleanup.txt
      operator/                     # editable; NOT in the manifest
        result.operator.yaml
        console-observation.txt
```

A preserved retry (`--new-attempt`) uses the same structure under:

```text
<evidence-root>/
  <matrixCaseId>/
    repetition-<n>__attempt-<YYYYMMDDTHHMMSSZ>-<runId>/
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Run recorded and **sealed**. Inspect `result.machine.json` for the lifecycle outcome — exit 0 does **not** mean the lifecycle passed. |
| 2 | CLI/preflight failure; no experiment allocated. |
| 3 | Experiment recorded but sealing or cleanup incomplete (not sealed). |
| 4 | Unexpected internal failure after allocation. |

## Diagnostic overrides

`--allow-dirty` and `--allow-noninteractive` make a `run` non-eligible.
`--allow-dirty` also permits consuming an attestation produced from a dirty tree, but
the resulting run remains non-eligible. `--allow-attestation-mismatch` exists only on
`preflight`; it produces diagnostic validation output and cannot create experiment
evidence. An operator verdict cannot make an overridden run eligible;
`summarize-matrix.mjs` must enforce this independently of the operator-entered verdict.

## Notes

- **Console output is not captured.** stdio is inherited by your console; the harness
  records `consoleOutputCapturedByHarness: false`. Your `console-observation.txt` and
  screenshot are the console record.
- **Operator files are outside the manifest.** Editing `operator/**` does not alter the
  sealed raw evidence; the summarizer validates those files separately.
- **Cleanup is emergency behavior.** After the observation window the harness may
  `taskkill` a surviving wrapper/fixture by recorded PID; this never rewrites the
  pre-cleanup classification and is not the interactive interrupt path.
- **Bounds.** Event/harness evidence is size-capped; a cap breach seal-blocks the run
  (exit 3) and is recorded, never silently dropped.

## Capture table (fill one row per run)

| matrixCaseId | rep | attemptTimestamp | digest (short) | experiment_validity | interactive_delivery | candidate (machine) | wrapper_completion_confirmed (operator) | batch_prompt_observed | eligibility_constraints_satisfied | event_protocol_valid | sealed | exit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| windows-terminal__powershell | 1 | | | | | | | | | | | |
| windows-terminal__powershell | 2 | | | | | | | | | | | |
| windows-terminal__powershell | 3 | | | | | | | | | | | |
| windows-terminal__cmd | 1 | | | | | | | | | | | |
| … | | | | | | | | | | | | |

A case is eligible only when its three consecutive rows each read:
`valid / received / machine clean_exit / operator clean_exit / batch prompt no /
eligibility_constraints_satisfied yes / event_protocol_valid yes / sealed / exit 0`,
under one attestation identity.
