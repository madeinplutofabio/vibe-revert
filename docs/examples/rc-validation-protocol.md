# RC beta-validation protocol (lean)

Prove the current post-fix candidate restores **local project files exactly** on three real
repositories matching the beta-report story, using only the public CLI on **packaged artifacts**.
Five fresh attempts (three restoration + two integration). The seven H10 attempts stay immutable
historical evidence (pre-fix, source commit `a8081359`); nothing here overwrites or reuses them.
Timebox the tooling to one focused working day; if it runs longer, simplify.

## Candidate — seal once

- Bump **all ten published packages** (`scripts/release-targets.json`) to the **next unused
  prerelease version**. Resolve `<next-unused-prerelease>` at seal time via the release tooling
  and a registry check (likely `0.7.1-beta.2`, but confirm availability — never assume, and never
  reuse `0.7.1-beta.1`). Run the four gates + the release-array drift check; commit.
- Pack the **real ten-package set** and install `viberevert@<version>` into an **isolated global
  prefix** whose `@viberevert/*` dependencies resolve from the packed set — not the workspace.
- **No registry fallback:** the one-time local registry (or pack set) must have **public-registry
  uplinks disabled for the candidate install**. All ten candidate packages must be present locally;
  npm must not silently satisfy a missing internal package from public npm.
- Record `candidate-identity.json`: `source_commit`, `version`, each tarball filename + full
  SHA-256, install command, registry URL/config, install prefix, resolved `viberevert` path,
  `viberevert --version`, `npm ls -g --json`, and the installed version + resolved root for **all
  ten** `@viberevert/*` + `viberevert` packages — **confirm every one is the candidate version**.
  Also capture `--help` for run/check/rollback/install/uninstall (+ their SHA-256).
- **Isolation proof:** `which viberevert` → the prefix; no workspace `bin` earlier on PATH; install
  root ≠ repo; no `@viberevert/*` resolves into the workspace.
- **Freeze the artifact** (the tarballs + source commit), not the repository. Documentation work may
  continue on another branch; the report must cite the exact tested artifact.
- **Re-seal** if any packed input changes (any `package.json`, `packages/*/src`, lockfile
  resolution, generated `dist`, executable shims, publishConfig): new version + seal + rerun.
- **Minimum Node for qualifying runs:** the published package's `engines.node` lower bound
  (currently `>=22`). Run **≥1 Phase-A round-trip on that Node major (Node 22.x)**. (The 22.14.0
  figure elsewhere is an npm Trusted-Publishing CI minimum, not the runtime floor.)

## "Exact" = local project-file state

Scope: tracked + staged state, tracked-unstaged content, **untracked non-ignored** paths + contents,
and the same HEAD commit. Ignored paths (`.viberevert/`, `node_modules/`, caches) are excluded via
git `--exclude-standard`; `.git/` is excluded; the evidence directory lives **outside** the repo.

**Do not assume `--exclude-standard` alone guarantees `.viberevert/` exclusion** — a run preflight
must confirm it (Phase A step 0). Directory topology and empty-directory remnants are recorded
**separately**, never counted as a file mismatch:

```
Project-file state exact: yes | no | not established
Directory topology changed: yes | no
Empty-directory remnants: <list>            # the documented #6 rollback-empty-dirs limitation
```

## Phase A — three restoration round-trips (unlock the report sentence)

`1D` Next.js / payment · `2D` Laravel / migration · `3B` FastAPI / deploy + infra. **≥1 run on Node
22.x**; record the host OS plainly (if all Windows, say so — dogfood-host evidence is separate from
the CI support matrix). Per run:

0. **Ignore preflight:** after `init`, confirm `.viberevert/` is ignored
   (`git check-ignore -q .viberevert`) and record the result; **fail qualification** if product or
   session state would enter the untracked comparison.
1. **Fixture baseline** (before `init`): fixture commit + content identity.
2. `viberevert init` (record `viberevert doctor` — validates `#5 doctor-pnpm`).
3. Create deliberate **staged + unstaged + untracked** work; record it.
4. **Rollback-target baseline** capture via `rc-capture.sh capture <out>` (`<out>` **outside** the repo).
5. **Public workflow only:** `viberevert run <agent>` → `check` → `rollback` (preview) →
   `rollback --apply`. No workaround, internal entry point, source-workspace command, or
   undocumented flag. (Native `run` validates `#1 run-agent-windows-shim`.)
6. **Post-apply** capture (same four dimensions).
7. `rc-capture.sh compare <baseline> <post-apply>` → `Project-file state exact: yes` iff all four match.
8. Record directory-topology + empty-dir remnants separately.
9. External effects — four distinct fields (see manifest).

**Pinned task** per run: `task-prompt.md` + SHA-256; agent product/version/model; forbidden actions
(run migration / deploy / email / payment / application API; edit evidence or `.viberevert/`; commit).

## Phase B — two integration checks (highest value)

`1E` Cursor MCP install/use/uninstall · `1F` GitHub Actions install/reinstall/update/uninstall. Each
target **includes pre-existing unrelated configuration** (a clean/empty target proves less). Pass
conditions come from `docs/installers-contract.md` per adapter — **not** a blanket byte-identical
restore: absent→absent; existing→restored per contract; unrelated config preserved; managed entries
removed; reinstall updates one managed entry without duplication; a drifted target produces the
documented drift refusal. Defer `2E` Claude MCP and `2F` pre-commit unless the H11 regression
evidence is thin, the report makes a specific live claim about them, or `1E`/`1F` expose a broader
problem.

## Evidence — one small manifest per attempt (`viberevert-rc-validation-1`)

```json
{
  "evidence_format": "viberevert-rc-validation-1",
  "attempt_id": "run1d-nextjs-rc",
  "retry_of": null,
  "candidate": { "identity_file": "candidate-identity.json", "identity_sha256": "" },
  "environment": { "os": "", "node": "", "agent": "" },
  "task": { "file": "task-prompt.md", "sha256": "" },
  "ignore_preflight": { "viberevert_ignored": null },
  "comparisons": {
    "head":      { "before": "", "after": "", "match": null },
    "staged":    { "before_sha256": "", "after_sha256": "", "match": null },
    "unstaged":  { "before_sha256": "", "after_sha256": "", "match": null },
    "untracked": { "before_sha256": "", "after_sha256": "", "match": null }
  },
  "project_file_state_exact": "yes | no | not-established",
  "directory_topology_changed": "yes | no",
  "empty_dir_remnants": [],
  "check":    { "risk_level": "", "categories": [], "exit_code": null },
  "rollback": { "preview": "", "apply": "" },
  "external_effects": {
    "provider_communication": "expected-and-observed",
    "task_domain_attempted":  "none",
    "task_domain_executed":   "none",
    "task_domain_observed":   "none-in-supplied-evidence"
  },
  "artifacts": {}
}
```

Finalize: write all artifacts → hash each → write the manifest (containing those hashes) → compute
`manifest.sha256` → make a **read-only copy** of the attempt directory. Never regenerate a manifest
in place. Any rerun uses a **new attempt id** linked via `retry_of` — a failed attempt remains valid
historical evidence and is not replaced.

## Failure handling

Preserve failed attempts (new suffix, `retry_of`). A product defect → fix + regression coverage +
new candidate version and seal + rerun every attempt needed for the common-candidate claim (not a
"retry once" under the same id). A Phase-A four-comparison mismatch → the "rolled back exactly"
sentence stays blocked → investigate a possible rollback regression. A Phase-B finding recurrence →
release blocker.

## "Untracked" boundary note (for the report)

The claim covers **untracked, non-ignored** files. The beta report / limitations link must qualify
"untracked" so it is not read as including ignored files such as `.env` or generated caches.

## Timebox

Tooling ready in ≤ 1 focused day (else simplify). Then ~1 day for `1D`/`2D`/`3B`, ~½ day for
`1E`/`1F`, ~½ day to review the evidence and draft the beta report. Agent/auth issues may extend
that; the evidence infrastructure itself must not consume a week.
