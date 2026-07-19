# Commercial boundary and reserved scope

## Purpose

This document draws the boundary between **what this repository is** -- the
open-source, local-first VibeRevert core -- and **what it deliberately is not**: a
hosted service, an account system, or a commercial control plane. It exists so
contributors and users understand the project's scope before opening a PR or
relying on a behavior, and so the open-source core stays clear of concerns that
would belong to a separate, out-of-repository product.

This is a **scope document, not a roadmap**. Nothing here announces or promises a
hosted or commercial product, a timeline, or a business model.

## What this repository is

VibeRevert (this repository) is an **Apache-2.0**, **local-first** CLI and set of
packages. Its default workflows -- checkpoint, check, rollback, prompt-fix, hooks,
MCP, and the guarded shell -- run entirely on the user's machine.

Default local workflows require **no**:

- account, login, or authentication;
- network connection or remote service;
- telemetry, analytics, or usage reporting;
- tenant, organization, team, or billing concept;
- background sync or upload.

The absence of any required account, hosted service, telemetry, tenancy, billing,
or background upload is an invariant of the default open-source workflow, not
merely an implementation accident. The [threat model](../THREAT_MODEL.md) states
the same boundary from the security angle; a privacy and data-handling contract,
when added, states it from the data angle. A network failure can never block a
local checkpoint, inspection, or rollback -- there is no network step in those
paths.

## Reserved namespaces

The following CLI namespaces are **reserved** so that a future hosted or
team-oriented capability -- if one is ever built -- could occupy them without
colliding with community contributions:

- `login`
- `sync`
- `org`
- `team`

Dashboards and billing are likewise **out of scope** for this repository.

**Reserved means documented, not stubbed.** These namespaces are **not**
implemented here: no placeholder commands, no flags, no config, no code paths.
Contributors should **not** add commands under these names, or introduce
account / tenancy / billing concepts into the core models, without first opening a
discussion -- such a change would blur the boundary this document draws.

## The dependency boundary

To keep the local core from silently acquiring server, cloud, or database
concerns, the repository ships a machine-readable dependency policy
(`dependency-boundary.json`, added in this milestone) that CI enforces:

- Web-server frameworks, cloud-provider SDKs, message/notification services, and
  database drivers are **forbidden by default** as **direct** dependencies of the
  workspace packages.
- A small set of integration libraries (e.g. a GitHub API or model-provider SDK)
  **require an explicit, expiring maintainer exception** before they may be added
  as a direct dependency: they have legitimate local-only uses, but a human must
  confirm the scope.

The boundary governs **direct** declarations by VibeRevert's own packages; a
transitive dependency pulled in by another library is not, by itself, a scope
violation. Dependency **licensing** is tracked separately in `LICENSE-AUDIT.md`.

## Non-claims

- This document does **not** announce, promise, or price any hosted or commercial
  product. It reserves scope; it does not commit to filling it.
- The Apache-2.0 license of this repository is unchanged by this document. This
  document does not determine the licensing or architecture of any hypothetical
  future service. Any separately distributed component may have separate terms,
  but the Apache-2.0 license of code already published in this repository remains
  unchanged.
- No default workflow transmits project or session data to a VibeRevert-operated
  service. Any future opt-in feature that transmits such data would require
  explicit, informed consent and clear documentation; it MUST NOT become a silent
  default.

## Maintaining this document

Any change that adds a network dependency to a default workflow, occupies a
reserved namespace, introduces account / tenancy / billing concepts into the core,
or alters the dependency boundary MUST update this document (and the related
policy files and contracts) in the same change.
