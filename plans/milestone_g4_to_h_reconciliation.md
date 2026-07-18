# M G4 -> M H reconciliation

M G4 (`viberevert shell --pty` transparent PTY bridge) shipped COMPLETE and CI-green on `main`, unpublished (Steps 0-6, ending at commit `5ee184f`; full ledger in the memory topic file and the refreshed `milestone_g4_plan.md`). It is not present in any published beta; the next promoted beta produced through M H will roll it up.

## Registry state verified at H0 (2026-07-18)

Canonical published beta = **`0.7.1-beta.1`** (`viberevert` dist-tags `latest == beta == 0.7.1-beta.1`). All ten publish targets are aligned at `0.7.1-beta.1`, with `latest == beta`.

The private package `@viberevert/policies-basic` is correctly absent from the public registry: npm returned a genuine package-not-found `E404`, not an authentication, connectivity, or rate-limit failure.

Collector-gap note: `viberevert-monorepo`, the private workspace root, was excluded by the package-name filter and therefore was not queried. It is not a publish target, so this does not affect the verified alignment of the ten release targets; its unpublished status was not independently rechecked in this command.

Per-package histories retain the documented partial-publish and bootstrap-recovery fingerprint:

- Full history `0.0.0 / 0.7.0-beta.0 / 0.7.1-beta.0 / 0.7.1-beta.1`: `checks`, `core`, `git`, `reporters`, `session-format` (5).
- Never carried `0.7.1-beta.0`: `cli-commands`, `mcp`, `viberevert` (3).
- First appeared at `0.7.1-beta.0`: `adapters`, `installers` (2).

All ten publish targets converged at `0.7.1-beta.1`.

## Archive refresh

`plans/milestone_g4_plan.md` was a Jul-15 snapshot predating Steps 5-6 and therefore did not fully represent the completed milestone. During H0, a status banner and reconstructed "Step 5 & 6 outcome" section were added from the memory ledger and landed commits, and the stale Step 6 TODO was marked complete. The original planned scope was not retroactively rewritten.

## What earlier milestones absorbed vs what H owns

Already shipped and not to be rebuilt in H:

- OIDC Trusted Publishing and npm provenance;
- `scripts/release-targets.json` and the release-drift invariants;
- both release smoke scripts;
- `docs/release-process.md`;
- `SECURITY.md` and `CONTRIBUTING.md`;
- package-content allowlists;
- existing path-confinement, schema/manifest, command-policy, audit-log hygiene, session-ownership/lock/race, and working-tree symlink tests.

H owns the remaining user-facing documentation, three live dogfood runs, and the tier-aware acceptance gate from the locked beta plan, plus the security-and-quality, compatibility, privacy, upgrade, release-evidence, commercial-boundary, launch, and quality-baseline tracks defined in the approved H plan.

The complete approved Milestone H plan was archived locally during H0 following the repository's established milestone-plan process.

## G4 follow-ups carried into H

1. Manual cross-OS terminal-restoration evidence, required before H15A because CI cannot prove it.
2. Compound/multiline PTY interception characterization in H1, before beta promotion.

Next: M H beta hardening and the next promoted beta after `0.7.1-beta.1`.
