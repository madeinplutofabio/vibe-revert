# M G1b -> M RH reconciliation

M G1b shipped as `v0.7.1-beta.1`, not `v0.7.1-beta.0`.
Reason: partial publish at `.beta.0` caused by missing Trusted Publisher config for first-release packages.
Recovery: manual bootstrap + Trusted Publisher + `.beta.1` canonical release.
Changesets: scaffolding landed, but manual bump fallback used.

The archived plan (`milestone_g1b_plan.md`) is a faithful copy of the plan as
locked; it references `v0.7.1-beta.0` as the release target throughout because
that was the target when the plan was written. The full incident record and
recovery path live in `docs/release-process.md` (v0.7.1-beta.1 retrospective).
The version-scheme conflict with Changesets prerelease semantics is tracked as
M G1b-followup-19 and will be resolved by M RH's beta manual-bump policy step.
No M G1b plan language is being rewritten.

Next: M RH (release hardening mini-milestone), then M G2 (run wrapper).
