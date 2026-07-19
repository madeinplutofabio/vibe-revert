# OpenSSF Best Practices & Scorecard gap analysis (planning evidence)

## Purpose and how to read this

This document assesses VibeRevert's current posture against two external
frameworks -- the **OpenSSF Best Practices Badge** (Passing level) and the
**OpenSSF Scorecard** checks -- and records, for each gap, the underlying
control, what kind of evidence would close it, and which Milestone H step owns
that work.

**This document is planning evidence; it is not itself a release control.** It
does not block a release. The *underlying controls* it points to may block, but
only per their own tier in the Milestone H plan (see the release-tier summary
below). Neither writing this assessment nor creating a file earns a framework
result: a badge or a Scorecard score is earned by the underlying control plus,
where the framework requires it, repository settings, merged-PR history, running
automation, or an official external assessment.

Three things are kept **separate** and must not be conflated:

1. **OpenSSF Best Practices Passing criteria** -- a self-certified questionnaire.
2. **OpenSSF Scorecard checks** -- automated heuristics over the repository, its
   workflows, dependencies, and releases.
3. **VibeRevert-specific beta hardening controls** -- project gates (threat
   model, six-job matrix, dependency license audit, ...) that are stronger than,
   or orthogonal to, either framework. Tracked here for traceability; they are
   **not** OpenSSF rows.

### Assessment basis and snapshot

Snapshot taken in **July 2026** against the then-current OpenSSF Best Practices
Passing criteria and OpenSSF Scorecard check documentation. Both frameworks
evolve -- Scorecard's own documentation states its checks change over time -- so
**H14 must rerun the official assessment** (a live Scorecard run and the actual
badge questionnaire) rather than treating this document as permanently current.

### Status vocabulary

- **met** -- satisfied from repository evidence alone.
- **apparently met, pending automated verification** -- repository evidence looks
  sufficient, but the framework's own tool must confirm (e.g. a live Scorecard
  run).
- **apparently met, pending self-certification** -- looks sufficient, but the
  Passing questionnaire must be answered by the maintainer.
- **partial** -- some of the control exists; measurable improvement remains.
- **gap** -- the control is absent.
- **external/manual verification required** -- closure needs repository settings,
  administrative visibility, or historical evidence, not files in Git.
- **not yet assessed** / **not applicable**.
- **accepted post-beta limitation** -- knowingly deferred; recorded, not hidden.

## Current strengths (met from repository evidence)

- **Least-privilege workflow tokens.** CI declares top-level
  `permissions: contents: read`; the release workflow grants `id-token: write`
  only to the publish job and `contents: write` only to the GitHub-Release job.
- **Provenance-backed publishing.** `npm publish --provenance` over OIDC Trusted
  Publishing, with annotated-tag enforcement and a pre-publish "already
  published?" 404 guard.
- **Declared FLOSS license** (Apache-2.0) and a **private security policy**
  ([`SECURITY.md`](../../SECURITY.md)) with an acknowledgment window and an
  explicit in/out-of-scope boundary.
- **Contribution guide, changelog, semver**, per-package publish allowlists, an
  exact-pinned build toolchain (Node), and a deep existing security test suite
  (path confinement, manifest/schema hostile input, command-policy matching,
  audit-log control-char/bidi hygiene, session ownership/lock/race).
- **No obviously dangerous workflow patterns.** The release workflow passes the
  tag through an environment variable rather than interpolating it into a shell
  step, avoiding the classic injection pattern.

## OpenSSF Best Practices (Passing) -- by criterion group

Grouped, not transcribed question-by-question; the exhaustive item-by-item answer
is the H14 badge application itself. Several Passing criteria evaluate *history*
and *responses*, not file presence -- those close only on self-certification with
real evidence, not on a commit here.

| Criterion group | Status | Basis / what remains | Owner |
|---|---|---|---|
| Basics (homepage, description, FLOSS license) | met | public repo, Apache-2.0, README | -- |
| Change control (public VCS, unique versioning, release notes) | met | GitHub, semver, `CHANGELOG.md`, GitHub Releases | -- |
| Reporting -- public bug-reporting process + searchable archive | apparently met, pending self-certification | GitHub Issues provides submission, tracking, and a searchable public archive | **H14** |
| Reporting -- response history | external/manual verification required | Passing asks whether the most recent bug reports and enhancement requests received responses; templates do not establish this | **H14** |
| Reporting -- published vulnerability-reporting process + private channel | met | `SECURITY.md` documents reporting and private submission | -- |
| Reporting -- vulnerability-response history | external/manual verification required | Passing evaluates initial response within 14 days for reports received in the preceding six months; N/A may apply when there were no reports | **H14** |
| Quality -- build, automated tests, tests for new work, warnings | met | CI lint/typecheck/build/test; strict TS + Biome; tests added per change | -- |
| Quality -- secure development knowledge | apparently met, pending self-certification | to be asserted in the H14 questionnaire | **H14** |
| Security -- secure delivery (HTTPS, provenance) | met | npm over HTTPS + OIDC provenance | -- |
| Security -- no leaked valid credentials | apparently met, pending self-certification | no known committed credentials from repository inspection; dedicated automated secret scanning not yet evidenced | **H5 / H14** |
| Security -- publicly known vulnerabilities fixed | not yet assessed | requires checking whether any medium-or-higher vulnerability has remained unpatched for more than 60 days; automation helps but does not itself answer the criterion | **H5 / H14** |
| Analysis -- static analysis | gap | Biome/tsc are linters, not SAST; no CodeQL | **H5** |
| Analysis -- dynamic analysis | not yet assessed / suggested criterion | the existing runtime and live PTY tests exercise behavior, but this assessment does not yet claim they satisfy the questionnaire's dynamic-analysis-tool criterion; fuzzing remains post-beta | **H14 / post-beta** |

## OpenSSF Scorecard -- by check

Every relevant check is named. Several can only be confirmed by a **live Scorecard
run** (H14), not by repository inspection; those are marked accordingly.

| Check | Status | Basis | Closure mechanism / step |
|---|---|---|---|
| Token-Permissions | apparently met, pending automated verification | least-privilege `permissions` in both workflows | live Scorecard run (H14) |
| Security-Policy | met | `SECURITY.md` with disclosure process | -- |
| License | met | Apache-2.0 `LICENSE` declared | -- |
| Dangerous-Workflow | apparently met, pending automated verification | tag via env var; no untrusted `${{ }}` in `run` | live Scorecard run (H14) |
| Binary-Artifacts | apparently met, pending automated verification | no binaries committed (node-pty prebuild fetched at install) | live Scorecard run (H14) |
| CI-Tests | apparently met, pending automated verification | CI runs tests on push + PR (the check inspects PR test runs, not job count) | live Scorecard run (H14) |
| Packaging | apparently met, pending automated verification | automated npm publish workflow | live Scorecard run (H14) |
| Maintained | apparently met, pending automated verification | active commit history (activity-window heuristic) | live Scorecard run (H14) |
| Vulnerabilities | not yet assessed | the check queries OSV for open vulnerabilities in the project or its dependencies; not yet run | OSV / `npm audit` (**H5**) + live Scorecard run (**H14**) |
| Pinned-Dependencies | partial | npm deps pinned by `pnpm-lock.yaml`; **GitHub Actions pinned by tag, not SHA** | SHA-pin actions (**H4**) |
| Dependency-Update-Tool | gap | no Dependabot/Renovate config | `dependabot.yml` (**H5**) |
| SAST | gap | no CodeQL / static-analysis workflow | CodeQL (**H5**) |
| SBOM | gap | no SBOM published with releases | SBOM in release (**H13**) |
| Signed-Releases | partial | npm **registry** provenance exists; GitHub **release assets** are not signed/attested -- npm provenance may not satisfy what this check detects on GH assets | artifact attestation + checksums (**H13**); verify post-publish (**H15C**) |
| Branch-Protection | external/manual verification required | force-push prevention, required reviews, status checks, code-owner review are **repository settings**, not files | repo settings + recorded evidence (**H4** / manual) |
| Code-Review | partial (residual structural limitation) | solo-maintained: `CODEOWNERS` + protected branches aid ownership, but the score depends on **merged-PR review evidence** and repo configuration, which a file cannot supply | H4 improves ownership; scoring depends on history/settings |
| CII-Best-Practices | gap (in progress) | evaluates the OpenSSF Best Practices badge; not yet earned. Passing earns **partial** Scorecard credit; Silver/Gold score higher | earn Passing (**H14**) |
| Contributors | accepted post-beta limitation | maturity signal (multiple contributors / orgs); solo project | post-beta |
| Fuzzing | accepted post-beta limitation | no fuzzing integrated | post-beta |
| Webhooks | not yet assessed | repository-settings heuristic | live Scorecard run (H14) |

## VibeRevert-specific beta hardening controls (not OpenSSF rows)

Project gates. Some also *influence* an OpenSSF check (noted), but they are
tracked separately because the frameworks neither prescribe nor fully capture
them.

| Control | Purpose | Relationship to a framework | Step | Tier |
|---|---|---|---|---|
| `THREAT_MODEL.md` | trust boundaries + realistic posture claims | Passing secure-design self-cert; **not** a named Scorecard check | **H3** | pre-publish |
| `CODE_OF_CONDUCT.md` | contributor governance and expected conduct | project governance control; **not** a Passing-level criterion or Scorecard check | **H3** | strong / core |
| `CODEOWNERS` + issue/PR templates | review ownership + contributor usability | supports (does **not** by itself earn) Code-Review | **H4** | strong / core |
| Six-job CI matrix (`{ubuntu,macos,windows} x {22,24}`) | cross-OS/Node coverage | strengthens, but is **not required by**, Scorecard CI-Tests | **H7** | pre-publish (the plan's CI line) |
| `LICENSE-AUDIT.md` (per-dependency license classification) | dependency / release compliance | distinct from the repo's own declared license; independent of the Scorecard License check (already met) | **H5** | pre-publish (license-clean) |
| `docs/commercial-boundary.md` | Apache-core / proprietary-control-plane boundary | -- | **H5** | pre-publish |
| SBOM + artifact attestation + checksums | release integrity | influences Scorecard SBOM + Signed-Releases | **H13** | strong / core |
| Scorecard workflow (SARIF) | runs the assessment + publishes results -- this is the **tool**, not a check | produces the Scorecard result surface | **H5** | strong / core |
| `dependency-review` PR gate | blocks vulnerable/incompatible new deps -- a **GitHub** control, **not** an OpenSSF check; recorded **conditional**, pending confirmation the repo visibility + selected action support the desired enforcement mode | -- | **H5** (conditional) | strong / core |
| Release-claim invariants (H-FP1) | product copy cannot overstate security | -- | H-FP1 | pre-publish |

## Release-tier summary

- **Pre-publish blockers** (green before H15B): threat model (H3),
  license-audit-clean + commercial boundary (H5), the six-job matrix (H7), plus
  the plan's other §18 blockers. *This assessment document is not itself a
  blocker.*
- **Strong pre-tag / core** (deferrable only by explicit maintainer decision):
  SHA-pinned actions (H4), governance files (H4), Dependabot + CodeQL + Scorecard
  workflow + conditional dependency-review (H5), SBOM/attestation/checksums (H13).
- **Concurrent / non-blocking**: the OpenSSF Passing submission and the live
  Scorecard run (H14).
- **Accepted post-beta limitations**: Fuzzing, Contributors, and the residual
  Code-Review scoring ceiling inherent to a solo-maintained project.

## Non-claims and maintenance rule

- VibeRevert does **not** claim the OpenSSF Passing badge is earned, and does
  **not** publish a Scorecard number as a badge, until each is actually earned by
  its own process. **Earn the control first; display the badge second.**
- OpenSSF **Silver/Gold** and any formal **SLSA-level** claim are out of scope
  for this beta and are never implied as achieved.
- A file in Git does not earn a framework result. Where a row's closure depends
  on **repository settings** (Branch-Protection), **historical behavior**
  (Code-Review, Maintained, the Passing response-history criteria), **running
  automation** (Dependency-Update-Tool, SAST, Vulnerabilities), or an **official
  external assessment** (CII-Best-Practices, the live Scorecard run), this
  document says so and does not treat the file as sufficient.
- **Maintenance:** revisit this assessment whenever a workflow, dependency
  policy, or governance file changes; rerun the official frameworks in H14.
