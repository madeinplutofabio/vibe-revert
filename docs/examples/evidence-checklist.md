# Evidence checklist

This checklist defines how each dogfood run is captured, isolated, and judged. The
[dogfood runbook](dogfood-runbook.md) references it for the capture rules; the
[report template](report-template.md) is filled from the evidence collected here.
All evidence is stored under the attempt's `<evidence-dir>` (an absolute path
outside the fixture).

## Scenario isolation

- Use a fresh clone, worktree, or fully reset fixture for each materially separate
  scenario.
- Installer and hook scenarios must not inherit state from one another unless
  coexistence is what is being tested.
- Reset or verify the fixture between adapter cases so one installation cannot make
  the next result misleading.

## Attempts and retries

- Each attempt has its own **attempt id** and its own `<evidence-dir>`. **Never
  reuse or overwrite an attempt directory**; a retry gets a new attempt id and a
  new directory.
- A transient environment or agent failure may be retried once, after recording
  the first attempt and restoring the scenario baseline.
- Authentication failures, secret exposure, unexpected external mutation, or
  corrupted baselines are **not** retried until the cause is understood.

## Baselines

Capture these before the actions they anchor, and do not assume they coincide.

**Repository baseline** — before `init` or any installer change:

- repository identity (URL or fixture id);
- `git rev-parse HEAD`, and the branch via `git branch --show-current` (record
  `detached` when no branch is checked out);
- `git status --porcelain=v1 -z`;
- the staged diff, the unstaged diff, and the untracked-file inventory;
- hashes or copies of any pre-existing integration files an installer might touch,
  so restoration can be checked against them.

**Session rollback baseline** — immediately before the direct agent run; the fixed
evidence set the final rollback comparison targets:

- `git rev-parse HEAD`;
- `git status --porcelain=v1 -z`;
- the staged diff;
- the unstaged diff;
- the untracked-file inventory;
- hashes of the selected relevant files.

**Tested VibeRevert build identity** — per run:

- CLI version (`viberevert --version`);
- the exact git commit or package provenance of the build;
- the install source (published beta package, local workspace build, or packed
  tarball);
- a checksum of the installed package or tarball where practical.

**Environment** — per run: OS, Node version, the agent and its version, any
installed integration and its version, the selected profile, and the exact task
prompt.

## Per-command and per-phase evidence

For **every command**, record:

- the exact command and working directory;
- start and end timestamps, and the completion mode (normal / timed-out /
  interrupted / aborted);
- exit code;
- stdout and stderr, captured **separately**;
- any resulting session, checkpoint, report, or receipt ids;
- generated files and their hashes;
- manual interventions and redactions.

At **phase boundaries and after any mutating command** — the agent run,
`rollback --apply`, the hook commit, and installer install/uninstall — additionally
capture the full Git state: `git rev-parse HEAD`, `git status --porcelain=v1 -z`,
the staged diff, the unstaged diff, and the untracked-file inventory. Do not repeat
the full Git-state capture after commands that do not intentionally mutate the
comparison scope, such as `check`, report rendering, or `prompt-fix`; capture their
outputs and generated operational artifacts separately.

Screenshots are useful supplementary evidence, but the primary evidence is text and
persisted artifacts another maintainer can inspect.

## Raw versus redacted evidence

- Capture raw stdout, stderr, exit code, and artifacts **first**. Never overwrite
  the original capture during redaction.
- Derive any redacted or summarized copy afterward, and record the relationship
  between the derivative and its raw source, including the SHA-256 hash of each
  file and the redaction method or notes.
- Raw captures may contain secrets and are **not** committed to this repository.
  Redact credentials and tokens without deleting the fact that authenticated access
  was used.

## Timeouts and interruptions

Define a timeout for every phase and record the completion mode (normal /
timed-out / interrupted / aborted). This matters especially for agent runs, MCP
stdio, hooks, and any PTY test.

## Evidence manifest

Each attempt's `<evidence-dir>` contains one `manifest.json` (or `manifest.yml`)
recording:

- the run id and attempt id;
- repository identity, branch, and starting commit;
- framework profile, agent, integration path, and task;
- the VibeRevert build identity and environment versions;
- start/end timestamps and completion mode;
- relative paths to raw stdout, stderr, artifacts, screenshots, and redacted
  derivatives;
- a SHA-256 hash for every captured file;
- whether each file is raw/restricted or shareable/redacted;
- the final outcome dimensions and the abort reason, if any.

Update the manifest only **after** each referenced file has been captured. Record
the manifest's own hash separately at closeout, in a file outside the manifest
itself (for example `manifest.sha256`), so the hash is not self-referential. Do not
commit raw restricted evidence. The restricted manifest records every captured
file; a sanitized derivative may omit restricted entries or replace sensitive paths
with stable opaque identifiers, while preserving hashes and provenance for every
file it does disclose.

## External-effects declaration (Case 1 / Case 2)

Every run records one explicit declaration, making the rollback scope boundary
visible — rollback restores Case 1 repository file state and cannot reverse Case 2
external effects (see [rollback limitations](../rollback-limitations.md)):

```yaml
external_effects:
  status: none-observed | observed | unknown
  database: none | <details>
  deployment: none | <details>
  api: none | <details>
  payment: none | <details>
  notification: none | <details>
  package_publication: none | <details>
  filesystem_outside_repository: none | <details>
  other: none | <details>
```

Tasks are repository-local by construction, so `none-observed` is the expected
result; anything observed is recorded, never manufactured. Use `unknown` for an
aborted or partially observed run — such a run must not claim `none-observed`
merely because capture ended early.

## Outcome dimensions

Use these independent outcome dimensions and allowed values for every run. Freeze
the schema before execution; assign the values from the captured evidence at
closeout.

- **VibeRevert result:** `passed | failed | blocked | not-completed` — the session
  was captured, artifacts are valid, and `check` / `report` / `prompt-fix` /
  `rollback` behaved according to contract.
- **Agent task result:** `passed | failed | not-evaluated` — whether the requested
  code change was correct.
- **Environment/integration result:** `clear | issue | blocked` — whether
  authentication, editor state, platform capability, or an external service
  affected the run.
- **Expected limitation observed:** `yes | no`; when `yes`, include the exact
  documentation reference and the observed behavior.

The dimensions are independent: an agent producing bad code can still be a
VibeRevert `passed` run if VibeRevert correctly records, flags, reports, and rolls
it back; conversely, good agent output does not prove VibeRevert worked.

## Abort handling

Stop the scenario and record the state if any of these occur:

- secret exposure in output or artifacts;
- an unexpected external mutation;
- a destructive command escaping the fixture;
- a corrupted baseline;
- inability to identify the session being tested.

On an abort:

- stop further commands;
- preserve the current raw evidence;
- capture the current Git and process state where safe to do so;
- record the reason and the last successful step;
- do not reset or clean the fixture until the evidence is secured.

For suspected **secret exposure**, additionally stop copying or publishing
artifacts and move the evidence into restricted storage. Redaction alone is not
enough if the credentials may still be live.
