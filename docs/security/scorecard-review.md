# OpenSSF Scorecard review (M H14)

Reviewed 2026-08-14 · commit `553a26b` · Scorecard v5.5.0 · aggregate **6.9/10**. One bounded review pass — each check dispositioned as fixed, accepted-with-rationale, or deferred. **No Scorecard badge is published for beta.3.**

## Result

| Check | Score | Disposition |
|---|---|---|
| SAST (CodeQL) · Security-Policy · Token-Permissions · Dangerous-Workflow · Binary-Artifacts · License · Maintained · Dependency-Update-Tool | 10 | pass |
| Pinned-Dependencies | 8 | accept (below) |
| Vulnerabilities | 5 | remediated: prod → 0; dev-only remain (below) |
| Branch-Protection | 3 | Tier-1 ruleset added |
| Code-Review · Contributors | 0 | accept (solo maintainer / solo project) |
| CII-Best-Practices | 0 | maintainer submits OpenSSF badge (non-blocking) |
| Fuzzing | 0 | post-beta (out of scope) |
| Packaging · CI-Tests · Signed-Releases | −1 | inconclusive; re-evaluate after H15 |

## Remediation — Vulnerabilities (0 → 5)

Nine production advisories (2 high, 6 moderate, 1 low), all transitive under `@viberevert/mcp → @modelcontextprotocol/sdk → { hono, @hono/node-server, express-rate-limit→ip-address, ajv→fast-uri }` — the SDK's **HTTP-server transport**, which VibeRevert does not use (its MCP server is stdio-only; `server.ts` imports only `StdioServerTransport`).

Fixed in `553a26b` with exact root `pnpm.overrides` (`hono 4.12.34`, `@hono/node-server 1.19.15`, `ip-address 10.3.1`, `fast-uri 3.1.5`); `pnpm audit --prod` now reports **0**.

**Scope:** these overrides remediate the **repository/CI lockfile**; they do **not** change dependency resolution for downstream consumers installing `@viberevert/mcp`. VibeRevert's MCP implementation uses the SDK's stdio transport rather than its HTTP-server transport, so the affected HTTP-server path is not part of VibeRevert's supported execution path. The SDK's declared ranges permit the patched transitive versions, while downstream resolution remains outside this repository's root override.

Six **dev-only** advisories remain (js-yaml via `@changesets/cli` + adapters test tooling; nanoid + postcss via `vitest`) — none shipped in any published package. They cap the Scorecard check below 10 (it scans the whole lockfile). Deferred, not chased.

## Branch-Protection (0 → 3)

Minimal `main` Repository **Ruleset**: block force pushes (`non_fast_forward`) + restrict deletions (`deletion`) — Scorecard's Tier-1, real safeguards that don't change the direct-to-`main` flow. Deliberately **not** required: PRs, reviewer approval, or pre-merge status checks (a status-check requirement is a post-beta workflow decision). Rulesets (not classic branch protection) so the default token can read them.

## Accepted with rationale

- **Pinned-Dependencies (8):** all GitHub Actions are full-SHA pinned; the remaining deduction is `npm install -g npm@11` in the release workflow. The npm CLI is intentionally major-pinned rather than exact-pinned so npm 11 security and compatibility patches can land without moving to a new major. Accepted tradeoff.
- **Code-Review / Contributors (0):** solo maintainer, direct-to-`main`; no second reviewer or multi-org contributors pre-community. Structural.
- **Fuzzing (0):** explicit non-goal for this track.
- **CII-Best-Practices (0):** OpenSSF Best Practices badge not yet submitted (maintainer action, non-blocking); the evidence it asks for is largely present.
- **Packaging / CI-Tests / Signed-Releases (−1):** inconclusive (heuristic didn't recognize the publish workflow; no PRs; no releases yet). Expected to re-evaluate after H15 (first tagged release → npm provenance + GitHub Release).

## Security and supply-chain evidence present

`SECURITY.md`, `LICENSE` (Apache-2.0) + `NOTICE`, CodeQL (SAST), Dependabot, SHA-pinned Actions + least-privilege tokens, `THREAT_MODEL.md`, license-audit + dependency-boundary checks, and the H13 provenance/SBOM/checksum release evidence.

## Post-beta bucket

Dev-tooling advisory cleanup; a pre-merge status-check ruleset; fuzzing; OpenSSF Best Practices badge submission. None are beta.3 blockers.
