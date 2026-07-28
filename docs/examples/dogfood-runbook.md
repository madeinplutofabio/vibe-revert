# Dogfood runbook

This is the single, product-wide procedure for the three real-world dogfood runs
(Next.js, Laravel, FastAPI). Apply the same main workflow to each repository. The
per-run allocation and coverage accounting live in the [run matrix](README.md);
the full capture, baseline, isolation, abort, and verdict rules live in the
[evidence checklist](evidence-checklist.md); how to write up a completed run lives
in the [report template](report-template.md).

These runs verify VibeRevert on real repositories; they do not measure agent
quality. Keep VibeRevert outcomes separate from agent-task outcomes (see the
outcome taxonomy in the evidence checklist).

## Task design

The representative task for each run must be **repository-local by construction**.
Do not ask an agent to deploy, publish packages, call production services, run
real migrations, or use live payment credentials in order to demonstrate that
rollback cannot reverse such effects. Record the Case 2 boundary (the
external-effects declaration) without intentionally creating dangerous Case 2
effects.

## Two baselines

Record two distinct baselines, and do not assume they are identical even in a
fresh fixture:

- **Repository baseline** — captured before `init` or any installer change. It is
  the reference for installer and hook restoration checks.
- **Session rollback baseline** — captured immediately before the direct agent
  run. It is the reference the final rollback comparison targets.

Both are recorded per the [evidence checklist](evidence-checklist.md).

## Evidence handling

The full capture specification is in the [evidence checklist](evidence-checklist.md);
these rules shape the commands below:

- **Define `<evidence-dir>` up front.** Choose an **absolute** path **outside** the
  fixture, create it before running any command, and record it in the run profile.
  Do not use a relative `evidence/` path that could land inside the repository
  under test.
- **Keep primary evidence outside the repository under test.** Write captured
  output, rendered reports, copied artifacts, hashes, and baselines under
  `<evidence-dir>`, so capturing evidence cannot contaminate the rollback
  comparison or be altered by rollback. The only files written into the fixture
  are those a scenario intentionally tests.
- **Capture raw first.** For every command record the exact command and working
  directory, start and end timestamps, exit code, and stdout and stderr
  separately, before any redaction; define a per-phase timeout and record the
  completion mode (normal / timed-out / interrupted / aborted).
- **Protect raw captures.** Raw captures may contain secrets; they are not
  committed to this repository. Shareable, redacted copies are derived from them
  and linked by hash (see the checklist).

## Phase 0 — Fixture and repository baseline

- Use a fresh clone, worktree, or fully reset fixture for each materially separate
  scenario. Installer and hook scenarios must not inherit state from one another
  unless coexistence is what you are testing.
- Record the **repository baseline**: repo identity, commit SHA and branch, git
  status, staged/unstaged/untracked state, tool versions, and hashes or copies of
  any pre-existing integration files an installer might touch.
- Record the **tested VibeRevert build identity**, not just the version string:
  the CLI version, the exact git commit or package provenance of the build, the
  install source (published beta package, local workspace build, or packed
  tarball), and a checksum of the installed package or tarball where practical.

## Phase 1 — Common preparation

```bash
viberevert --version
viberevert init --profile <nextjs|laravel|python>
viberevert doctor
```

- `init`: record the generated `.viberevert.yml` and the created `.viberevert/`.
- `doctor`: record the **exit code and every reported status**, including warnings
  and capability-dependent skips, and whether the result matches the documented
  environment. Do not treat non-green output as failure by default — a
  capability-gated skip on a platform can be expected.

## Phase 2 — Must-excellent mutation path (direct agent session)

Run this contiguous path on **every** repository, driven by a direct guarded
session. Do **not** install hooks, adapters, or GitHub Actions between the session
checkpoint and the rollback verification: path-based rollback could otherwise
overwrite or entangle those changes.

**1. Session rollback baseline.** Capture it immediately before the run.

**2. Guarded agent run.** Run the repository's assigned command-line agent inside
a guarded session and capture the emitted session id:

```bash
viberevert run <agent-command>
#   the agent performs this repo's repository-local task (see the run matrix);
#   run prints:  Next: viberevert check --since sess_<id>
```

Use `viberevert run claude` on at least one repository. For another command-line
agent, replace `<agent-command>` with its real launch command. If `run` does not
produce an ended session id, stop that scenario and record the outcome — do not
substitute another session or continue with session-based evidence.

**3. Check and report** against that session (rendered reports go under
`<evidence-dir>`, not the fixture). Execute commands through the evidence-capture
procedure so stdout, stderr, exit code, timestamps, and completion mode are stored
separately; the redirections below show only where the rendered report body should
be copied:

```bash
viberevert check --since <sess_id>                # record exit code: 0 clean / 2 blocked
viberevert report --session <sess_id>             # terminal render
viberevert report --session <sess_id> --json     > <evidence-dir>/report.json
viberevert report --session <sess_id> --markdown > <evidence-dir>/report.md
```

**4. Verify deterministic `prompt-fix`** — render it twice **without changing the
persisted report**:

```bash
viberevert prompt-fix --session <sess_id>         # copy fix-prompt.txt -> <evidence-dir>/fix-prompt.1.txt
viberevert prompt-fix --session <sess_id>         # copy fix-prompt.txt -> <evidence-dir>/fix-prompt.2.txt
```

Compare the two copies byte-for-byte and record both hashes; they must be
identical. Do not run an agent against the fix prompt before this comparison — a
further mutation would complicate the contiguous rollback path.

**5. Roll back — preview, decide, then apply.**

```bash
viberevert rollback <sess_id>                     # dry-run preview; record the receipt
```

Review the dry-run receipt before applying: confirm the target session is correct,
the expected paths are included, the excluded paths are understood, and no
unexpected destructive change is proposed. If the preview is refused or
unexpected, record the result and stop — do not use `--force` merely to complete
the dogfood script. Any deliberate `--force` test belongs in an isolated
should-good scenario, not the must-excellent happy path.

```bash
viberevert rollback <sess_id> --apply             # apply
```

**6. Rollback verification (end of the mutation path).** Compare Git-managed
working-tree and index state, plus the captured untracked paths within rollback
scope, against the **session rollback baseline**:

- `HEAD` — verify rollback did not move it from its value immediately before
  rollback application;
- the staged diff, the unstaged diff, and the untracked-file inventory — the
  working tree and index must match the session baseline within the captured,
  non-excluded scope;
- hashes of the captured relevant files.

Do not expect VibeRevert's own operational artifacts under `.viberevert/`
(reports, receipts, the fix prompt) to match the pre-session baseline; preserve
and evaluate them separately as evidence. Record any paths left untouched by
`rollback.exclude`, and complete the run's **external-effects declaration** (the
Case 1 / Case 2 boundary).

## Phase 3 — Driver variants (agent vs integration coverage)

Agent coverage and integration coverage are separate: a repository can be counted
for one via a direct session and for the other via an installed integration.

- **Variant A — direct guarded run.** This is the Phase 2 path, driven by the
  repository's assigned command-line agent. **Claude Code (`viberevert run claude`)
  is a required direct-driver case on at least one repository**; it does not have
  to drive all three.
- **Variant B — installed Cursor integration.** On the assigned repository, run
  `viberevert install --cursor`, then trigger the integration through its **own**
  documented path and **verify separately** what it actually does — whether it
  creates a VibeRevert session, checkpoint, or report, or only invokes a check at
  its integration boundary. Do not assume it produces a `sess_<id>`, or that
  `check --since` / `rollback` apply to it; record the integration's real
  behavior. Then uninstall symmetrically (`viberevert uninstall --cursor`) and
  confirm restoration against the repository baseline.

## Phase 4 — Installer and hook coverage (isolated)

Each installer case is its own scenario on a reset fixture, uninstalled with the
**matching selector**. Do not use `--all` as cleanup for individually installed
adapters.

```bash
# Legacy git hook (kept separate from the --direct adapter):
viberevert hook install
#   make a deliberate change in the isolated fixture, stage ONLY that change,
#   then commit so the hook runs check; record the hook's exit code and output:
git commit -m "dogfood: exercise the pre-commit hook"
viberevert hook uninstall                             # --restore if a backup exists
```

```bash
# Per-adapter, symmetric install/uninstall (one selector each):
viberevert install --cursor        ; viberevert uninstall --cursor
viberevert install --claude        ; viberevert uninstall --claude
viberevert install --github-action ; viberevert uninstall --github-action
```

```bash
# The safe set as its own case (installs cursor/direct/husky/lefthook/claude;
# --all excludes github-action):
viberevert install --all           ; viberevert uninstall --all
```

Verify `hook uninstall` against the pre-existing hook-file baseline. Then reset or
discard the deliberate fixture commit and working-tree changes through the
fixture-management procedure — hook uninstall is not responsible for restoring git
history or test content. For every adapter case, reset or verify the fixture
between cases, and confirm each uninstall restored the files that installer owns
or backed up to their pre-existing baseline — scoped to that installer, not the
complete repository baseline.

## Phase 5 — MCP read-only coverage

On at least one repository, launch `viberevert mcp serve` **through a known MCP
client or test harness** — the server speaks stdio, so an interactive terminal
cannot drive the protocol by hand. Invoke the documented read-only tools, capture
each request and result, stop the server cleanly, and verify the append-only
audit records. Record the exact client and version. See the
[MCP contract](../mcp-contract.md).

## Tier coverage

Complete the product-wide surface **across** the three runs; do not force every
action into every run.

**Must-excellent — on all three repositories (Phases 1–2):**

- `init` with the explicit profile
- `doctor`, output recorded rather than assumed green
- direct guarded agent session
- session-based `check`
- terminal, JSON, and Markdown report rendering
- deterministic `prompt-fix`, verified by a byte-identical double render
- `rollback` preview, reviewed before apply
- `rollback --apply`
- working-tree and index comparison against the session rollback baseline
- explicit record of external effects rollback did not reverse

**Should-good — at least once across the trio (assigned in the run matrix):**

- Cursor install / use / uninstall on at least one repository
- Claude integration install / use / uninstall on at least one repository,
  separately from `run claude`
- pre-commit hook on at least one clean fixture state
- GitHub Actions install / uninstall on at least one repository
- MCP server startup plus the documented read-only tool exercises
- `--all` install / uninstall once, as its own safe-set case

**Can-basic — recorded as shipped / partial / deferred:**

- `shell --pty`
- approval-gated MCP operations
- profiles or adapters outside the locked trio

## Per-run profile header

Copy this block into each run's report (see the [report template](report-template.md)):

```
## Run profile

- Repository:
- Evidence directory:
- Framework:
- Agent:
- Integration path:
- Task prompt:
- Tier deviations:
```
