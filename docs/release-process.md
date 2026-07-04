# Release process

> Smoke-test the packed CLI against a fresh git repo before pushing release-bearing changes.

**Status:** `v0.7.1-beta.1` shipped. Internal contributor doc.

This document covers the local smoke-test workflow for VibeRevert: how to build the current M B package set as tarballs, install them into a throwaway scratch directory, and exercise the CLI against a real `git init` repo. The workflow surfaces release-packaging issues that the workspace-internal `pnpm test` cannot — most importantly, cross-package `workspace:*` dependency resolution in a packed install.

## When to run

- Before any commit that changes package dependencies, public exports, or `bin` entry points.
- Before a `git push` that includes changes to `packages/cli/`, `packages/git/`, `packages/core/`, or `packages/session-format/`.
- After bumping any `package.json` `version` field.
- Before tagging a release.

`pnpm test` and `pnpm build` do not catch packaging problems because they resolve workspace-internal deps via the monorepo, not via locally packed tarballs.

## Quick path: automated helper

The fastest path is the included PowerShell helper:

```powershell
# Windows PowerShell 5.1 (system default)
powershell.exe -ExecutionPolicy Bypass -File scripts/smoke-test.ps1

# Or PowerShell 7+ (pwsh)
pwsh -File scripts/smoke-test.ps1
```

The script:

1. Builds the workspace (`pnpm build`) before packing so the smoke test never exercises stale `dist/` output.
2. Packs all 10 publish-target packages (`@viberevert/session-format`, `@viberevert/core`, `@viberevert/git`, `@viberevert/checks`, `@viberevert/reporters`, `@viberevert/adapters`, `@viberevert/installers`, `@viberevert/cli-commands`, `@viberevert/mcp`, `viberevert`) into a temp dir.
3. Sets up a throwaway scratch directory with a real `git init` and committed initial state.
4. Installs the packed tarballs (with the `pnpm.overrides` workaround — see Known Issues below).
5. Exercises the full CLI command surface (`init`, `doctor`, `--version`, `start`/`end`, `checkpoint`/`checkpoints`/`sessions`, `check`, `report`, `prompt-fix`, `rollback`, `hook install`/`uninstall`, `mcp serve`) across 38 phases including Phase 12f's MCP stdio probe (driven by `scripts/mcp-stdio-probe.mjs`).
6. Cleans up scratch + pack directories on success; on failure, prints their paths before exiting so the failure can be inspected.

Exit code 0 on success; non-zero with a clear error on failure. The script does NOT push or publish. It runs `pnpm build`, so it may update normal build artifacts, but it does not intentionally modify source files.

A POSIX (bash) equivalent is not provided yet; the user's local environment is Windows + PowerShell, and a POSIX port can be added when CI needs the same flow on Linux.

## Manual procedure

If the helper fails and you need to bisect the steps by hand:

### 1. Build, then pack the current M B package set into a fresh dir

```powershell
pnpm build  # MUST run first — pnpm pack does not rebuild stale dist/

$packDir = Join-Path $env:TEMP "viberevert-pack-$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Force $packDir | Out-Null

pnpm --filter @viberevert/session-format `
     --filter @viberevert/core `
     --filter @viberevert/git `
     --filter viberevert `
     pack --pack-destination $packDir
```

POSIX equivalent: substitute `$PACK_DIR` for `$env:PACK_DIR` and use forward slashes.

### 2. Create a scratch consumer dir + init a real git repo

The CLI requires a git repo. The scratch dir mimics a fresh user project:

```powershell
$scratch = Join-Path $env:TEMP "viberevert-smoke-$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Force $scratch | Out-Null
Push-Location $scratch
git init --quiet
git config user.name "Smoke Test"
git config user.email "smoke@example.com"
"hello" | Out-File -FilePath README.md -Encoding ascii
git add README.md
git commit -q -m "initial"
```

### 3. Write a consumer `package.json` with the `pnpm.overrides` workaround

See Known Issues §1 for the locked shape. Write the file using the UTF-8-no-BOM technique from Known Issues §2 (`Out-File -Encoding utf8` would write a BOM that Node's `JSON.parse` rejects).

### 4. `pnpm install` + exercise the CLI

```powershell
pnpm install --silent
pnpm exec viberevert init --profile generic
pnpm exec viberevert checkpoint --name smoke-test
# ... continue per the command list above
```

### 5. Clean up

```powershell
Pop-Location
Remove-Item -Recurse -Force $scratch
Remove-Item -Recurse -Force $packDir
```

## Known issues

### 1. `pnpm.overrides` for cross-package `workspace:*` resolution

**Problem.** `pnpm pack` strips `workspace:*` dependency specifiers from `package.json` to literal version strings (e.g., `"@viberevert/session-format": "workspace:*"` becomes `"@viberevert/session-format": "0.7.0-beta"`). When the resulting tarball is installed into a scratch directory, pnpm sees the literal version, tries to resolve it against the npm registry, and fails with `ERR_PNPM_FETCH_404` because the packages aren't published yet.

**Workaround.** The smoke-test consumer's `package.json` MUST declare top-level `@viberevert/*` deps as `file:` references AND include a `pnpm.overrides` block forcing every transitive resolution to the local tarball:

```json
{
  "name": "viberevert-smoke",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "@viberevert/session-format": "file:<pack-dir>/viberevert-session-format-0.7.0-beta.tgz",
    "@viberevert/core": "file:<pack-dir>/viberevert-core-0.7.0-beta.tgz",
    "@viberevert/git": "file:<pack-dir>/viberevert-git-0.7.0-beta.tgz",
    "viberevert": "file:<pack-dir>/viberevert-0.7.0-beta.tgz"
  },
  "pnpm": {
    "overrides": {
      "@viberevert/session-format": "file:<pack-dir>/viberevert-session-format-0.7.0-beta.tgz",
      "@viberevert/core": "file:<pack-dir>/viberevert-core-0.7.0-beta.tgz",
      "@viberevert/git": "file:<pack-dir>/viberevert-git-0.7.0-beta.tgz"
    }
  }
}
```

The `dependencies` block satisfies the top-level `viberevert` dep plus the direct internal deps; the `pnpm.overrides` block forces transitive resolutions inside `viberevert`'s own dep tree to use the local tarballs instead of the npm registry.

This workaround is the canonical local-smoke-test pattern for unpublished version states and for CI's `release-dry-run` job. It is NOT needed for the post-publish smoke (`scripts/post-publish-smoke.ps1`), which installs `viberevert@beta` from the npm registry directly.

### 2. PowerShell 5.1 UTF-8 BOM in JSON test fixtures

**Problem.** PowerShell 5.1's `Out-File -Encoding utf8` and `Set-Content -Encoding utf8` both write UTF-8 with a leading BOM (`EF BB BF`). Node's `JSON.parse` rejects files that start with a BOM, producing a `SyntaxError: Unexpected token` error citing the literal BOM character (`U+FEFF`) at JSON position 0.

**Workaround.** For any file Node will read as JSON (`package.json`, fixture JSON, `lock.json`, etc.), write with `[System.IO.File]::WriteAllText` using a `UTF8Encoding` constructed with `$false` (no-BOM):

```powershell
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
```

This affects any .NET-via-PowerShell file write that Node will later parse as JSON. The same pattern applies to any text format that is BOM-sensitive (YAML loaders are mixed; some accept BOM, some don't).

PowerShell 7+ (`pwsh`) defaults `-Encoding utf8` to no-BOM, so this gotcha is specific to PowerShell 5.1. The smoke-test helper script targets PowerShell 5.1 because it is the system PowerShell on Windows 10 and Windows 11 without an explicit `pwsh` install.

### 3. PowerShell 5.1 ASCII-only discipline for .ps1 scripts

**Problem.** PowerShell 5.1 reads `.ps1` script files via the active Windows code page (commonly Windows-1252 on US/EU systems) when the file has no BOM. UTF-8 multi-byte characters in source then garble at parse time. An em-dash (`—`, U+2014, UTF-8 bytes `E2 80 94`) decodes to `â€"` under Windows-1252 — the trailing `"` terminates any surrounding string literal, producing parser errors of the form:

```
At C:\path\to\script.ps1:LINE char:COL
+ ...         throw "violation â€" identifier follows here...
+                                  ~~~~~~~~~~~~~~
Unexpected token 'identifier' in expression or statement.
```

The cascade of follow-on `Missing closing '}'` errors is symptomatic — the real failure is the orphaned `"` from the garbled em-dash bytes.

**Workaround.** Keep `.ps1` source files **ASCII-only** unless the repository deliberately switches its `.ps1` encoding strategy (BOM-prefixed UTF-8, or pwsh-only execution). Concretely:

- No em-dashes (`—`) → use `--`.
- No en-dashes (`–`) → use `-`.
- No smart quotes (`‘`, `’`, `“`, `”`) → use straight `'` / `"`.
- No arrows (`→`, `←`, `↔`) → use `->`, `<-`, `<->`.
- No ellipsis (`…`) → use `...`.
- No other multi-byte Unicode in source.

**Verification.** Before committing changes to any `.ps1` file, run a non-ASCII scan. From PowerShell:

```powershell
# Should return zero matches; any output indicates a future parse-time hazard.
Select-String -Path scripts/smoke-test.ps1 -Pattern '[^\x00-\x7F]'
```

Or from any shell with ripgrep:

```sh
rg -P '[^\x00-\x7F]' scripts/smoke-test.ps1
```

**Background.** This is the read-side facet of the same root cause as §2 (PowerShell 5.1's UTF-8 handling is BOM-dependent). §2 covers the write-side — files PowerShell *creates* without `UTF8Encoding($false)` get an unwanted BOM that breaks downstream JSON parsers. §3 covers the read-side — files PowerShell *reads* without a BOM get parsed via the active code page, which mangles multi-byte UTF-8. Both facets disappear under pwsh 7+ (PowerShell 7's `.ps1` parser is UTF-8 by default), but the repo's smoke-test target is Windows PowerShell 5.1 because it is the system PowerShell on stock Windows 10/11.

## Publishing to npm

VibeRevert publishes 10 packages to npm via the GitHub Actions release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)), triggered by an annotated tag push. The workflow authenticates exclusively via npm **Trusted Publishers (OIDC)** -- no long-lived token is stored. Local `npm publish` is reserved for emergencies and requires its own auth path (see [Manual emergency publish](#manual-emergency-publish)).

### Trusted Publisher setup

Each of the 10 publish-target packages on npm has a per-package Trusted Publisher configuration linking the package to this repo's `release.yml` workflow. When the workflow publishes, npm CLI 11.5.1+ exchanges a GitHub Actions OIDC token for short-lived publish credentials -- no `NPM_TOKEN` secret is required or used.

#### Prerequisite: package bootstrap before Trusted Publisher

npm's Trusted Publisher UI requires the package to exist before its access page is reachable. For each publish-target package, a one-time first publish must happen before npm can attach a Trusted Publisher configuration to that package. The first publish must use a non-OIDC auth path, such as interactive `npm login` or a granular access token, with `npm publish --access public`. After that single bootstrap, the package's Settings → Access page becomes available and Trusted Publisher can be configured.

This bootstrap has been done for all 10 packages: the original 8 (`viberevert@0.0.0` + `@viberevert/{session-format,core,git,checks,reporters,cli-commands,mcp}@0.0.0`) were bootstrapped at a `0.0.0` placeholder before `v0.7.0-beta.0`; `@viberevert/adapters` and `@viberevert/installers` were bootstrapped at `0.7.1-beta.0` (dist-tag `bootstrap`) during the v0.7.1-beta.0 partial-publish recovery. Any future new package requires its own bootstrap before it can join the OIDC publish flow -- see the new-publish-target gate in the v0.7.1-beta.1 retrospective.

#### Per-package Trusted Publisher configuration

For each of the 10 packages, on its npm Settings → Access page:

1. Under "Trusted Publisher", select **GitHub Actions**.
2. Configure:
   - **Repository owner**: `madeinplutofabio`
   - **Repository name**: `vibe-revert`
   - **Workflow filename**: `release.yml`
   - **Environment**: (leave blank)
3. Save. The publisher policy takes effect immediately for subsequent publishes.

Verification: all 10 packages must show the configured Trusted Publisher block before the release workflow can publish. The workflow has no `NPM_TOKEN` fallback; missing or mis-configured Trusted Publisher on any single package fails that package's `npm publish` step.

#### Publishing access posture

Per-package "Publishing access" should be set to **"Require two-factor authentication and disallow tokens (recommended)"** for production safety. This forces all publishes through Trusted Publishers and removes the token-bypass path entirely. The release workflow operates correctly under this strict posture (no token is involved).

Manual emergency publish requires temporarily relaxing this setting; see [Manual emergency publish](#manual-emergency-publish).

### Version policy (beta phase)

During v0.x beta patch-line releases, versions are hand-bumped to the planned
beta target. Changesets adoption is deferred until the first stable or next
semantically aligned release line.

Rationale: Changesets pre-mode projects the next version from the
`initialVersions` snapshot taken when pre-mode is entered. From a
`0.7.0-beta.0` baseline it produces `0.7.0-beta.1`, never the per-milestone
patch-line target (`0.7.1-beta.0`) this project uses during the beta phase
(verified in the M G1b Step 8 scratch preflight). Forcing the tool to produce
a shape it does not naturally produce is not worth the drift risk.

Concretely:

- All 10 publish-target `package.json` versions are edited by hand (or by a
  reviewed mechanical edit) to the planned target before tagging.
- The Changesets scaffolding (`.changeset/config.json`, root `changeset:*`
  scripts, `@changesets/cli` devDependency) stays in the repo but dormant: no
  `.changeset/*.md` entries are committed, and no `changeset version` or
  `changeset pre` commands run against main.
- Respins follow the partial-publish policy below: increment the beta counter
  (`.beta.N` -> `.beta.N+1`), never reuse a version.
- Revisit at the first stable release: enter Changesets pre-mode from a clean
  stable baseline for the following line (M G1b-followup-1 / -19).

### Tag-driven publish flow

The release workflow triggers ONLY on annotated tag pushes matching the beta regex `v<MAJOR>.<MINOR>.<PATCH>-beta.<N>`. Stable releases ship through a separate workflow path (not yet implemented).

End-to-end:

1. **Bump versions locally.** Update all 10 publish-target `package.json` files to the new beta version.
2. **Commit + push to main.** CI's `build-and-test` and `release-dry-run` jobs validate the new version end-to-end.
3. **New publish-target gate** (required whenever a package becomes newly
   public in this release; skip only when the publish set is unchanged from
   the previous release). Every item must pass before tagging:
   - Package exists on npm, or an approved bootstrap plan has already been
     completed before tagging. Bootstrap publishes must use `pnpm pack`
     tarballs, not `npm publish` from package directories, so `workspace:*`
     dependencies are rewritten before npm receives the manifest.
   - Maintainer can publish/create the package (org scope rights).
   - Trusted Publisher is configured on npm for each newly public package,
     using `release.yml` as the workflow filename.
   - Package is included in `scripts/release-targets.json` and the release
     workflow publish arrays/order (enforced by the release-targets drift
     invariants in `packages/cli/test/architectural-invariants.test.ts`).
   - pnpm-packed manifest has no `workspace:*` dependency leakage (inspect
     the packed tarball's `package.json`).
   - A `workflow_dispatch` dry-run passes.
4. **Create the annotated tag** (must be annotated; lightweight tags are rejected):
   ```sh
   git tag -a v0.7.0-beta.0 -m "v0.7.0-beta.0"
   ```
5. **Push the tag:**
   ```sh
   git push origin v0.7.0-beta.0
   ```
6. **Workflow runs automatically.** 3 jobs in strict sequence: `publish` (Ubuntu) → `post-publish-smoke` (Windows PowerShell 5.1) → `github-release` (Ubuntu).

The `publish` job performs (in order, fail-fast):

- Tag regex validation (beta-only)
- Annotated-tag enforcement via `git cat-file -t <tag>` (must be `"tag"`, not `"commit"`)
- Cross-package version assertion (all 10 publish targets must equal tag suffix; 2 private packages must remain `private: true` at `0.0.0`)
- npm CLI + Node version verification (npm `>= 11.5.1`, Node `>= 22.14.0` -- required by npm Trusted Publishing)
- Full 4-gate: typecheck + lint + test + build
- Pack 10 publish-target tarballs via `pnpm pack` (asserts directory → package-name mapping; asserts count == 10)
- Pre-publish `npm view` guard (404-strict: any non-404 error fails)
- Publish 10 packed `.tgz` files in dependency-safe order via `npm publish <tarball> --access public --tag beta --provenance` (no auth token; OIDC token issued via `id-token: write` permission + per-package Trusted Publisher config)

`post-publish-smoke` runs `scripts/post-publish-smoke.ps1` on `windows-latest` with PowerShell 5.1; it installs `viberevert@beta` from npm and runs the full 7-frame Phase 12f MCP transcript against the published bytes. PowerShell 5.1 is intentional: it's the same parser that exposed Step 3's BOM-injection class, so the published path proves the same Windows surface.

`github-release` creates a prerelease GitHub Release pointing at the tag, with body describing the published packages.

### Provenance attestation

The `--provenance` flag enables SLSA attestation via GitHub OIDC. The publish job declares `permissions: id-token: write` to allow OIDC token issuance. Published packages on npm show a "Provenance" badge linking back to the workflow run.

### dist-tag discipline

All beta publishes go to dist-tag `beta`, NEVER `latest`. The workflow hardcodes `--tag beta`. Users install with:

```sh
npm install viberevert@beta
```

**Beta-phase `latest` policy (adopted in M RH):** after a release's
post-publish smoke passes, the maintainer manually advances `latest` to the
new beta on all 10 publish targets:

```sh
npm dist-tag add <pkg>@<version> latest
# repeat for each publish target in scripts/release-targets.json
```

Rationale: before M RH, unqualified `npm install viberevert` resolved the
empty `0.0.0` Trusted-Publisher-bootstrap placeholder, which is strictly
worse than the current verified beta. The workflow itself never touches
`latest`; the advance is a deliberate manual post-verification action.
`viberevert@beta` remains the documented install spec. At the first stable
release, the stable workflow path takes ownership of `latest`.

### Rollback procedure

If a published version is broken, **do NOT use `npm unpublish`** -- the 72-hour window has strict dep-graph restrictions and damages dependent packages' integrity. Instead, deprecate:

```sh
npm deprecate viberevert@0.7.0-beta.N "Broken: <reason>. Use 0.7.0-beta.<N+1>."
# Repeat for each of the 10 published packages
```

Then fix the issue + bump to `0.7.0-beta.<N+1>` per the partial-publish policy.

### Partial-publish failure policy

- **Pre-publish failure** (validation/build/test/pack/npm-view-guard fails before any `npm publish` runs): safe to retry the same tag.
  ```sh
  git tag -d v0.7.0-beta.N
  git push origin --delete v0.7.0-beta.N
  # fix the issue, recreate and push the tag
  ```

- **Partial-publish failure** (at least 1 of the 10 packages already landed on npm when the workflow failed): DO NOT reuse the tag or version -- npm versions are effectively immutable. Treat as a new beta iteration:
  1. Deprecate the partially-published packages.
  2. Bump all 10 publish-target versions to `0.7.0-beta.<N+1>`.
  3. Commit, tag `v0.7.0-beta.<N+1>`, push.

## Tagging convention

### Format

`v<MAJOR>.<MINOR>.<PATCH>[-beta.<N>]`

Examples:
- `v0.7.0-beta.0` — first beta of v0.7.0
- `v0.7.0-beta.1` — second beta iteration (after first beta needed a respin)
- `v0.7.0` — stable (not supported by current release workflow; separate stable workflow path TBD)

### Package version equals tag suffix

The version in all 10 publish-target `package.json` files MUST equal the tag suffix (sans `v` prefix). The release workflow asserts this and refuses to publish on mismatch.

### Annotated tags only

Lightweight tags (`git tag <name>`) are refs pointing at a commit. Annotated tags (`git tag -a <name> -m "<msg>"`) carry tagger metadata. The release workflow enforces annotated tags via `git cat-file -t <tag>` checking for type `"tag"`.

```sh
git tag -a v0.7.0-beta.0 -m "v0.7.0-beta.0"
git push origin v0.7.0-beta.0
```

### Tag signing

The current workflow accepts unsigned annotated tags. GPG/SSH signing via `git tag -s` is a known follow-up (M RP-2 task) and will be enforced via workflow validation once signing infrastructure is in place. For v0.7.0-beta releases, annotated unsigned tags are acceptable.

## Manual emergency publish

The canonical publish path is the GitHub Actions release workflow, which uses Trusted Publishers / OIDC and requires no token. **Manual emergency publish is for the unusual case where the workflow cannot run** (GitHub Actions outage, release.yml regression that blocks publish, etc.) AND a critical fix MUST publish immediately.

### When to use

- GitHub Actions is down AND a critical fix MUST publish immediately.
- A workflow regression makes the release workflow itself unusable, blocking a needed publish.

DO NOT use this path for routine releases. Reroute everything possible through the workflow.

### Auth prerequisites (manual path)

Manual `npm publish` cannot use OIDC -- there is no GitHub Actions runner outside CI. It requires a local npm CLI auth path:

1. **A pre-existing token in `~/.npmrc`** with publish rights on `viberevert` + `@viberevert/*`. Fastest path if you've kept an emergency token for this purpose (and rotate it on a schedule).
2. **Or an interactive `npm login`** to acquire fresh credentials at the time of need (typically requires 2FA).

The npm-side package settings must ALSO allow token-based publishing:

- Each package's **Settings → Access → Publishing access** must NOT be set to "Require two-factor authentication and disallow tokens (recommended)".
- That recommended-secure setting blocks all token-based publishes by design. If it is active, manual publish will fail with an auth error until the setting is intentionally relaxed.

If packages are configured Trusted-Publisher-only (the recommended posture), token publishing must be temporarily allowed on each affected package BEFORE attempting manual publish. **Restore the recommended posture immediately after the emergency publish completes** (see step 10 below).

### Procedure

From repo root, with a clean working tree at the release commit:

1. **Verify local state matches the intended release.**
   - `git status` clean.
   - All 10 publish-target `package.json` versions equal the target version.
   - `pnpm install --frozen-lockfile`
   - `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

2. **Verify npm CLI version.** `npm --version` must report `>= 11.5.1` (same minimum as the release workflow). Upgrade with `npm install -g npm@11` if needed.

3. **Acquire npm auth.** Choose ONE:
   - Use a pre-existing `~/.npmrc` token: confirm `npm whoami` returns the publisher account.
   - Or run `npm login` interactively and complete 2FA.

4. **Temporarily allow token publishing** on each of the 10 packages (only required if "Require two-factor authentication and disallow tokens" is currently set):
   - For each package's npm Settings → Access → Publishing access, temporarily select a publishing-access mode that permits manual npm CLI publishing with your chosen local auth path.
   - Update each of the 10 package settings pages.

5. **Pre-publish guard.** For each of the 10 publish-target packages, confirm `npm view <pkg>@<version>` returns 404.

6. **Disable the release workflow** to prevent the manual tag push from triggering a competing CI publish run.
   - GitHub repo → Actions → Release → "..." menu → "Disable workflow".
   - Without this, pushing the tag in step 8 will trigger `.github/workflows/release.yml`. The pre-publish `npm view` guard inside the workflow will fail (the packages were just published manually in step 7), but the workflow run will be a noisy red CI signal and MUST NOT be interpreted as the canonical release.

7. **Pack + publish in dependency-safe order:**
   ```sh
   PACK_DIR=$(mktemp -d)
   for dir in packages/session-format packages/core packages/git packages/checks packages/reporters packages/adapters packages/installers packages/cli-commands packages/mcp packages/cli; do
     (cd "$dir" && pnpm pack --pack-destination "$PACK_DIR")
   done

   for tgz in viberevert-session-format viberevert-core viberevert-git viberevert-checks viberevert-reporters viberevert-adapters viberevert-installers viberevert-cli-commands viberevert-mcp viberevert; do
     npm publish "$PACK_DIR/${tgz}-<VERSION>.tgz" --access public --tag beta
   done
   ```
   Note: `--provenance` is NOT used here -- it requires OIDC, which is unavailable outside GitHub Actions.

8. **Tag + push** (the Release workflow is disabled, so this push does not trigger the canonical publish workflow):
   ```sh
   git tag -a v0.7.0-beta.N -m "v0.7.0-beta.N (emergency manual publish)"
   git push origin v0.7.0-beta.N
   ```

9. **Run the post-publish smoke manually:**
   ```powershell
   powershell.exe -ExecutionPolicy Bypass -File scripts/post-publish-smoke.ps1 -ExpectedVersion 0.7.0-beta.N
   ```

10. **Restore the safe posture on all 10 packages:**
    - For each package's Settings → Access → Publishing access, switch back to "Require two-factor authentication and disallow tokens (recommended)".
    - Confirm Trusted Publisher is still configured (it should be; the OIDC config is separate from the tokens-posture toggle).
    - Routine releases must continue to flow through OIDC only.

11. **Create the GitHub Release** via `gh release create` or the web UI. The release body should explicitly note the manual emergency publish path AND that provenance is absent on this version.

12. **Re-enable the release workflow** immediately after the emergency release is documented:
    - GitHub repo → Actions → Release → "..." menu → "Enable workflow".
    - Do NOT leave the workflow disabled. The next routine beta MUST go through the canonical path.

### Caveats

- **Provenance attestation is LOST.** Manual `npm publish` cannot generate SLSA provenance because there is no GitHub Actions OIDC token outside the workflow runner. Published packages will show no "Provenance" badge on npm for the emergency version.
- **Open a follow-up** to fix the underlying reason the workflow wasn't usable, and **re-publish via the workflow at the next beta iteration** to restore provenance.
- **Token rotation.** If an emergency token was used in step 3.1, rotate it on the npm Settings → Tokens page after the emergency is over.

## First-beta retrospective

Captured 2026-06-22, after `v0.7.0-beta.0` shipped via run [27918710334](https://github.com/madeinplutofabio/vibe-revert/actions/runs/27918710334).

### What worked

- **Trusted Publisher / OIDC.** Once configured per-package, eliminated the entire `NPM_TOKEN` attack surface -- no long-lived secret to rotate, and publish provenance attestations are emitted automatically by npm CLI 11.5.1+ running under `id-token: write`.
- **Locked publish set + directory-to-name mapping assertion.** The workflow enumerates the 8 publish targets explicitly and asserts each tarball filename maps to the expected package name before any `npm publish` runs. Prevented the entire class of "wrong package published" failures.
- **404-strict `npm view` pre-publish guard.** Confirmed that no version `0.7.0-beta.0` already existed for any of the 8 packages before the publish loop started -- safety belt against a partial re-publish overwriting earlier work.
- **Post-publish smoke on Windows PowerShell 5.1.** Validated published bytes against the same parser class that surfaced the BOM injection bug in Step 3. The probe installed `viberevert@beta` from the live registry (with 80s of retry budget for npm CDN propagation), ran the full 7-frame MCP transcript via `scripts/mcp-stdio-probe.mjs`, and confirmed graceful stdin-EOF shutdown in 1m24s.
- **Bumping the canonical commit to fix a workflow defect, then deleting and recreating the tag at the new HEAD.** Safe pre-publish retry pattern that required no version bump -- npm never saw `0.7.0-beta.0` until the workflow was actually correct.

### What surprised

- **In the first tag-triggered release run, the runner did not have the annotated tag object available after checkout** even with `fetch-depth: 0`. Required `fetch-tags: true` in the checkout step AND an explicit `git fetch origin refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}` step before the annotated-tag check could see the tag's true type. Without both, the tag arrived as a lightweight ref and the validation step rejected it.
- **Workflow gate order matters between `release.yml` and `ci.yml`.** Tests resolve cross-package workspace deps via the `dist/` symlinks; running Test before Build breaks resolution with "Failed to resolve entry for package" errors. Both workflows MUST use the same Lint -> Typecheck -> Build -> Test order. `release.yml` was reordered in Step 4E to match `ci.yml` exactly.
- **npm Trusted Publisher configuration requires the package to exist before its Access page is reachable.** Bootstrapped each of the 8 packages at version `0.0.0` via interactive `npm login` + `npm publish --access public` BEFORE the per-package OIDC trust config could be set in the npm UI. Chicken-and-egg solved with a one-time placeholder publish.
- **PowerShell 5.1's `Process.StandardInput` auto-`StreamWriter` injects a UTF-8 BOM preamble** when first written to. Broke MCP JSON-RPC framing silently in Step 3 (the SDK's stream consumer parsed `\uFEFF{...}` as malformed JSON). Pivoted the entire MCP stdio transport to a Node-side probe (`scripts/mcp-stdio-probe.mjs`) that owns byte-level framing with explicit UTF-8 `Buffer` writes -- removes PowerShell/.NET from the transport path entirely.
- **`softprops/action-gh-release@v2` emitted an action-runtime deprecation warning during the first beta release run.** Not a failure mode -- the release-creation step still succeeded -- but flagged as a tracking item.

### Pinned for `v0.7.1-beta` (M RP follow-ups)

- **M RP-2 -- Tag signing.** Add `git tag -s` enforcement to the validate step. Requires GPG or SSH signing infrastructure for the maintainer's publishing account.
- **Track or replace `softprops/action-gh-release`** if the runtime deprecation warning becomes blocking; `gh release create` is the fallback.
- **First changesets-driven release.** Validate the `pnpm changeset` workflow end-to-end on `v0.7.1-beta`. Exercises per-package `CHANGELOG.md` generation as documented in `CONTRIBUTING.md`.
- **CI matrix expansion** to macOS and additional supported Node versions. Keep the release-publish job on Node 22+ because npm Trusted Publishing requires Node >=22.14.0.
- **husky / commitlint enforcement.** Currently cultural convention only -- no enforcement at commit time.
- **`viberevert@latest` dist-tag policy.** Currently points at the `0.0.0` placeholder from the Trusted Publisher bootstrap. The first stable `v0.7.0` (sans `-beta`) will promote to `latest` via a separate stable-release workflow path (M RP-3 if dedicated work is needed).

## v0.7.1-beta.1 retrospective

Captured 2026-07-04, after `v0.7.1-beta.1` shipped via run [28685789240](https://github.com/madeinplutofabio/vibe-revert/actions/runs/28685789240). This release expanded the publish set from 8 to 10 packages (`@viberevert/adapters` and `@viberevert/installers` first-released) and was the first release cut through the workflow_dispatch dry-run + tag-push flow added in M G1b Step 10.

### Incident: partial publish at v0.7.1-beta.0

The first tag-push release for v0.7.1-beta.0 partially published before failing at `@viberevert/adapters` because the two first-release packages lacked npm Trusted Publisher configuration. The recovery manually bootstrapped adapters/installers at 0.7.1-beta.0 from pnpm-packed tarballs, configured Trusted Publisher, then cut v0.7.1-beta.1 as the canonical release.

Details:

- The `v0.7.1-beta.0` run ([28683702293](https://github.com/madeinplutofabio/vibe-revert/actions/runs/28683702293)) published 5 of 10 packages (session-format, core, git, checks, reporters) before `npm publish` failed with `ENEEDAUTH` on `@viberevert/adapters`. The publish loop is fail-fast, so the remaining 5 never ran; post-publish smoke and the GitHub Release were correctly skipped.
- Root cause: the Trusted Publisher bootstrap (see above) covered the original 8 packages. `@viberevert/adapters` and `@viberevert/installers` were flipped from private stubs in M G1b Step 8 and never received the per-package bootstrap + trust configuration. Neither the workflow-structure assertions nor the workflow_dispatch dry-run could catch this: the dry-run intentionally skips the real `npm publish` step, and npm-side publish authority is not visible to any read-only preflight.
- Recovery: manually published the two packages at the burned `0.7.1-beta.0` from `pnpm pack` tarballs (dist-tag `bootstrap`, `--access public`; the packed installers manifest was verified to carry the concrete `@viberevert/adapters: 0.7.1-beta.0` dependency, not `workspace:*`), configured Trusted Publisher for both, bumped all 10 targets to `0.7.1-beta.1`, and released through the canonical tag-push flow. All 10 published with provenance; smoke and GitHub Release green.
- Per the partial-publish policy, `v0.7.1-beta.0` was not completed or reused. The five CI-published and two bootstrap-published `0.7.1-beta.0` versions remain on npm as superseded artifacts.

### New publish target gate

Any release where a package becomes newly public MUST pass this pre-tag checklist:

- Package exists on npm or has an approved bootstrap plan.
- Maintainer can publish/create the package (org scope rights).
- Trusted Publisher is configured for `release.yml`.
- Package is included in the release workflow publish arrays and topo order.
- pnpm-packed manifest has no `workspace:*` dependency leakage.
- A workflow_dispatch dry-run passes.

Adopted as step 3 of the tag-driven publish flow above (M G1b-followup-20, resolved in M RH).

### What worked

- The workflow_dispatch dry-run path (Step 10) validated everything it was designed to validate -- tag regex, version consistency, pack surface, and the 404-strict availability guard -- and its publish/smoke/release gating held exactly as designed in both dispatch and tag-push modes.
- Hard-stop discipline: the partial publish was inspected before any action; nothing was unpublished or force-completed at the failed version.
- The fail-fast publish loop plus topo order limited the blast radius: the 5 published packages are self-consistent (no package carries a dependency on an unpublished sibling at that version).
- The pnpm-pack + tarball-inspection discipline for the manual bootstrap prevented a `workspace:*` manifest from ever reaching npm.

### Open hygiene items (owners)

- Deprecate the superseded `0.7.1-beta.0` versions -- resolved in M RH: all 7 deprecated with per-package messages pointing at `0.7.1-beta.1`.
- `bootstrap` dist-tag + `latest` hygiene -- resolved in M RH: `bootstrap` tags removed, and `latest` advanced to `0.7.1-beta.1` on all 10 packages under the beta-phase `latest` policy documented in the dist-tag discipline section (M G1b-followup-22).
- `dist/*.tsbuildinfo` shipped in the adapters and installers tarballs; the other packages already kept their build info outside `dist/` -- resolved in M RH by aligning all packages to `./build.tsbuildinfo` (M G1b-followup-21).
- `softprops/action-gh-release@v2` emitted a Node runtime deprecation warning during the release run -- still non-blocking; `gh release create` remains the fallback.
- Changesets was NOT the version driver for this release: the Step 8 preflight showed Changesets pre-mode projects `0.7.0-beta.1` from a `0.7.0-beta.0` baseline, so versions were hand-bumped per the D101.H fallback. Supersedes the "First changesets-driven release" pinned item above; see M G1b-followup-1 and -19.

## License

Apache-2.0. See the repository `LICENSE` and `NOTICE` files.
