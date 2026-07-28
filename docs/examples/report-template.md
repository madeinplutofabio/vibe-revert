# Dogfood run report

One dogfood run, filled from the evidence captured under the run's evidence
directory per the [evidence checklist](evidence-checklist.md), following the
[dogfood runbook](dogfood-runbook.md). Keep VibeRevert results separate from
agent-task results.

A report is not `verified` merely because the run completed. Verification requires
checking every material claim against the captured evidence and reconciling the
per-run tier statuses with the product-wide matrix.

## Run profile

- Run ID:
- Attempt number:
- Attempt status: `completed | aborted | superseded-by-retry`
- Evidence attempt ID:
- Sanitized evidence manifest:
- Restricted evidence location: recorded privately / not applicable
- Repository:
- Framework:
- Agent:
- Integration path:
- Task prompt:
- Start / end:
- Completion mode: `normal | timed-out | interrupted | aborted`
- Tier deviations:

When a retry occurs, link the related attempt ids here; do not overwrite or
silently replace the earlier result.

## Environment and build identity

- OS / Node version:
- Agent and integration versions:
- VibeRevert CLI version:
- Build provenance (git commit or package), install source, and checksum:

## Phase results

Record each phase with these fields:

- **Status:** `not-run | attempted | passed | failed | blocked`
- **Commands:**
- **Exit codes:**
- **Produced IDs:**
- **Evidence references:**
- **Deviations / observations:**

### Phase 0 — fixture and repository baseline

Fixture reset method; the repository baseline (HEAD / branch, status, and
integration-file hashes).

### Phase 1 — preparation

`init` (profile written) and `doctor` (exit code and full status summary).

### Phase 2 — mutation path (direct agent session)

The standard fields, plus:

- Emitted ended-session id:
- Report JSON hash / Report Markdown hash:
- `prompt-fix` hash 1 / hash 2 / byte-comparison result:
- Rollback-preview decision: `approved | refused | unexpected`
- Rollback-apply result:
- Stopped before apply: `yes | no`

### Phase 3 — driver variant

Direct guarded run and/or installed Cursor integration; for the integration, what
it actually produced (session / checkpoint / report / check-only).

### Phase 4 — installers and hook

Each install/uninstall case, the hook commit result, and restoration checks against
the repository baseline.

### Phase 5 — MCP read-only

Client and version, tools exercised, audit records verified.

## Rollback verification

- Session rollback baseline evidence:
- `HEAD` immediately before apply:
- `HEAD` immediately after apply:
- Staged diff comparison: `match | mismatch | not-evaluated`
- Unstaged diff comparison: `match | mismatch | not-evaluated`
- In-scope untracked inventory comparison: `match | mismatch | not-evaluated`
- Relevant-file hash comparison: `match | mismatch | not-evaluated`
- Excluded paths and expected differences:
- `.viberevert/` operational artifacts preserved and evaluated separately:

## External-effects declaration

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

## Outcome dimensions

- **VibeRevert result:** `passed | failed | blocked | not-completed`
- **Agent task result:** `passed | failed | not-evaluated`
- **Environment/integration result:** `clear | issue | blocked`
- **Expected limitation observed:** `yes | no` (if `yes`, include the reference and
  observed behavior)

## Tier coverage

Record every tier item assigned to this run (see the [run matrix](README.md)) with
its status:

- `<item>`: `planned | attempted | passed | failed | blocked | not-run`

The product-wide matrix records the planned allocation; this section supplies the
actual evidence-backed status.

## Limitations, interventions, and aborts

- Observed limitations, with documentation references:
- Manual interventions and redactions:
- Abort, if any: reason and last successful step.

## Evidence

- Restricted manifest and its hash (`manifest.sha256`):
- Sanitized manifest committed or published:
- Key disclosed artifacts and their SHA-256 hashes:
- Omitted restricted entries, represented by opaque identifiers:

## Closeout

- Report status: `draft | verified | published | withdrawn`
- Verified by:
- Verification date:
- Evidence manifest hash checked: `yes | no`
- All assigned matrix items reconciled: `yes | no`
- Unresolved contradictions:
- Related attempts:
- Supersedes / superseded by:
- Publication scope: `private | sanitized-public`
- Final sign-off:
