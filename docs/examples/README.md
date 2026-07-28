# Dogfood runs

This directory holds the preparation for VibeRevert's three real-world dogfood runs
(Next.js, Laravel, FastAPI) and the completed run reports. The runs verify
VibeRevert on real repositories; they do not measure agent quality.

## Documents

- [Dogfood runbook](dogfood-runbook.md) — the single product-wide execution
  procedure and tier coverage.
- [Evidence checklist](evidence-checklist.md) — reproducible capture, baselines,
  isolation, aborts, and the outcome dimensions.
- [Report template](report-template.md) — how one completed run is reported.
- Completed run reports are added here, one per run.

## Run matrix (planned allocation)

Freeze this before any live run. Allocation may shift; the coverage invariants
below may not. This records the **planned** allocation — actual, evidence-backed
status is tracked in coverage accounting and in each run's report.

| # | Repository | Profile | Direct agent session | Installed integration | Extra should-good |
|---|---|---|---|---|---|
| 1 | Next.js | `nextjs` | Claude Code | Cursor | GitHub Actions |
| 2 | Laravel | `laravel` | Claude Code or best fit | Claude integration | pre-commit hook |
| 3 | FastAPI | `python` | best fit | `--all` (isolated case) | MCP read-only |

## Coverage accounting

Give every assigned item a status and update it as runs complete:
`planned | attempted | passed | failed | blocked | not-run`.

Must-excellent mutation round trip:

- Repo 1 (Next.js): `planned`
- Repo 2 (Laravel): `planned`
- Repo 3 (FastAPI): `planned`

Should-good (each assigned to a specific run):

- Cursor integration — Repo 1: `planned`
- Claude integration, separate from `run claude` — Repo 2: `planned`
- GitHub Actions install/uninstall — Repo 1: `planned`
- pre-commit hook — Repo 2: `planned`
- MCP read-only — Repo 3: `planned`
- `--all` install/uninstall, isolated — Repo 3: `planned`

Agent coverage:

- Claude Code used as a direct driver (at least once): `planned`
- Cursor integration used (at least once): `planned`

## Coverage invariants

The final allocation may differ, but it must satisfy all of:

- all three must-excellent mutation round trips are attempted and reported; any
  failed, blocked, or not-completed result remains visible and is not replaced by a
  later successful attempt;
- Claude Code is used as a direct driver at least once;
- the Cursor integration is used at least once;
- every should-good item is assigned to a specific run;
- the MCP read-only server is exercised at least once;
- `--all` install/uninstall is dogfooded once as its own isolated case;
- nothing is omitted on the assumption that another run covers it;
- every coverage-accounting status is backed by a verified report and reconciled
  with related attempts; `planned` is not a final status.

## How to use

1. Freeze this matrix and the coverage accounting before any live run.
2. For each run, follow the [runbook](dogfood-runbook.md), capture evidence per the
   [checklist](evidence-checklist.md), and write it up with the
   [report template](report-template.md).
3. After each run, update the coverage-accounting statuses from the verified report.
4. A run is not closed out until its report is verified or explicitly withdrawn, and
   its coverage statuses are reconciled against this matrix.
