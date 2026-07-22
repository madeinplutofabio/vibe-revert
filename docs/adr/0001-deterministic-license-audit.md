# ADR 0001: Deterministic, committed-source license audit

- Status: Accepted — 2026-07-20
- Milestone: H5 (dependency governance + license audit)
- Related: `dependency-boundary.json` policy + checker (M H5), `THREAT_MODEL.md`

## Context

VibeRevert ships an Apache-2.0 local core with third-party dependencies. The beta
requires a license audit that is (a) reproducible by any contributor and in CI to the
same bytes, (b) honest about what is unknown, and (c) a clear separation between
detected facts and this repository's policy. A naive audit that reads `node_modules`
fails (a): pnpm installs a platform-dependent subset of the graph (e.g. `@biomejs/biome`
declares `@biomejs/cli-win32-x64`, `@biomejs/cli-darwin-arm64`, ... as
optionalDependencies; on Linux CI those are in the lockfile but never installed), so a
Windows regeneration and a Linux `--check` would disagree, and platform-excluded
packages would silently lack metadata. The audit is informational for this milestone —
it is not a dependency admission gate and makes no legal determination.

## Decisions

### 1. Committed graph, manifests, and metadata are the only authoritative inputs

The audit's authoritative data inputs are committed files only: `pnpm-lock.yaml` (the
resolved third-party graph identities and transitive edges), the workspace
`package.json` manifests (authoritative for all direct declaration kinds, including
`peerDependencies`), `license-metadata.json` (a committed cache of platform-independent
package facts), and `license-policy.json` (this repository's disposition table). The
workspace manifests are committed data, not host-dependent like `node_modules`, so they
do not reintroduce the platform problem of decision 2. No other data input may influence
the generated document. The generated document also records the generator schema
version, because the renderer implementation is itself part of what determines the
output bytes — changing renderer logic can legitimately change the artifact.

### 2. Installed `node_modules` is rejected as authoritative

pnpm's installed layout is an implementation detail and platform-dependent. It is never
read during generation or checking. This is what makes a local Windows check and Linux
CI agree, and keeps "unknown" genuinely unknown rather than host-dependent.

### 3. Package facts come from an integrity-verified metadata cache

`license-metadata.json` keys every entry by immutable identity (`name`, `version`, and
the lockfile `resolution.integrity`). Entries record only detected facts (raw license
value, normalized SPDX when unambiguous, the metadata source, packaged
`LICENSE*`/`COPYING*`/`NOTICE*` filenames, tarball integrity) or an explicit
collection-failure status with a reason. The cache is refreshed only by an explicit,
provenance-recording operation (see 4); generation never mutates it.

### 4. Metadata refresh is integrity-verified and provenance-recorded

`refresh:license-metadata` may retrieve package content from the local pnpm store first
and fall back to fetching the exact immutable registry tarball for the lockfile-resolved
version. The store is only a retrieval optimization, never a trust source: content from
either source is verified against the exact lockfile integrity before any metadata is
extracted; a store object that cannot be tied unambiguously to the requested
identity+integrity is ignored; redirects are accepted only if the final bytes still
verify; and no metadata is committed when verification fails. Unsupported sources (git,
local directory, tarballs without usable integrity, non-registry protocols) receive an
explicit collection-failure status rather than guessed metadata. The retrieval method
(`retrievalSource`) is recorded separately from the factual metadata source
(`licenseMetadataSource`), so that "downloaded from the registry" is never confused with
"license inferred from registry metadata." Refresh collects independent packages
best-effort with per-entry failures recorded, but exits non-zero if any required package
could not be collected or verified.

### 5. Regeneration is offline and deterministic

`regen:license-audit` consumes only the three committed files and produces
`LICENSE-AUDIT.md` deterministically. It performs no network access and no cache
mutation. It fails (a generation error) when a lockfile package has no matching cache
entry, when an entry's integrity no longer matches the lockfile, or when any committed
input is malformed or an unsupported schema version. A matching cache entry whose
collection status is unsuccessful is still incomplete metadata and causes regeneration to
fail; it is not converted into a `review-required` license result, because no verified
package facts were collected. CI freshness checking therefore never depends on the
network.

### 6. Traversal identity is the snapshot key; report rows aggregate by `name@version`

pnpm may contain multiple snapshot instances of one `name@version` because of
peer-resolution context. Graph traversal uses the exact lockfile package/snapshot key as
node identity (peer-resolution suffixes preserved as resolution context). Instances are
aggregated into a single `name@version` report row only after verifying they agree on
integrity, detected license, packaged legal files, and disposition; the contributing
snapshot keys are retained, and any conflict becomes `review-required` rather than a
silent deduplication.

### 7. Reachability posture uses explicit edge transitions and a fixed precedence

Direct declaration kinds come from the workspace manifests: `dependencies` →
`production`, `optionalDependencies` → `optional-production`, `devDependencies` →
`development`, `peerDependencies` → `peer`. Each declaration is resolved to an immutable
snapshot via the corresponding lockfile importer entry, and the lockfile and manifests
are cross-validated in both directions (a lockfile importer dependency with no matching
manifest declaration, or a section mismatch, is a generation error). An unresolved
production, optional-production, or development declaration is a generation error; only
an unresolved peer is a separately-reported consumer-supplied obligation. A dependency's
posture then propagates by an explicit transition from its parent's posture and the edge
kind:

| Incoming            | required edge       | optional edge       |
| ------------------- | ------------------- | ------------------- |
| production          | production          | optional-production |
| optional-production | optional-production | optional-production |
| peer                | peer                | peer                |
| development         | development         | development         |

A package reached by several paths retains all reaching postures; its primary reported
posture is the maximum under `production > optional-production > peer > development`. A
peer dependency is a consumer-supplied runtime obligation — distinct from a
development-only dependency and from one installed directly as production. First-party
workspace packages (`link:`/`workspace:`) are excluded from the third-party audit and
listed separately.

### 8. Factual metadata is separated from repository policy

Detected facts (`rawLicense`, `normalizedSpdx`, `licenseMetadataSource`,
`packagedLegalFiles`) never carry a legal conclusion. `license-policy.json` maps a single
SPDX identifier to a `policyDisposition` (`allowed`, `allowed-with-obligations`,
`review-required`, `disallowed`) with explicit `obligations`. Compound expressions,
legacy/array/object license values, `SEE LICENSE IN ...`, missing fields, and conflicting
instance metadata all default to `review-required`. Obligations are explicit policy data;
the presence or absence of a NOTICE file is never inferred into an obligation. Obligation
labels are conservative project workflow markers, not a complete statement of legal
obligations. The authoritative terms remain the applicable license text.

### 9. Generation errors are distinct from review/disallowed results

A missing graph node, corrupt or stale or incomplete cache, unsupported schema, or
integrity mismatch is a generation error and stops regeneration. A valid package whose
license is unclear is `review-required` and appears as a row in the report. A known
license mapped to `disallowed` is a policy result shown as a row. Because the audit is
informational this milestone, regeneration does not fail merely because review-required
or disallowed rows exist; that would change only if H5 later promotes the audit to an
admission gate.

## Consequences

- The generated `LICENSE-AUDIT.md` states its inputs by hash (SHA-256 of the raw
  `pnpm-lock.yaml` bytes; a deterministic workspace-manifest digest over each manifest's
  repository-relative path and raw-byte SHA-256; and the raw `license-policy.json` and
  `license-metadata.json` bytes), the generator schema version, and the snapshot-instance
  and aggregated-row counts, and carries no timestamp — so two audits can be compared and
  explained without wall-clock noise.
- Both committed schemas (`license-policy.json`, `license-metadata.json`) are versioned
  and strictly validated (unknown fields, unsupported versions, duplicate identities, and
  cache entries unreferenced by the current lockfile are rejected).
- The audit is more machinery than a scanner one-liner, but it is the first design under
  which local (any OS) and CI agree, unknowns stay unknown, and every claim is either a
  verified fact or an explicitly reviewed policy decision.

## Status of this audit

This audit is informational and provides no legal certainty. Detected licenses are
scanner-derived facts; dispositions are this repository's policy, not legal advice.
