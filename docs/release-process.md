# Release process

> Smoke-test the packed CLI against a fresh git repo before pushing release-bearing changes.

**Status:** `v0.7.0-beta` work in progress. Internal contributor doc.

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
2. Packs the currently pack-tested packages (`@viberevert/session-format`, `@viberevert/core`, `@viberevert/git`, `viberevert`) into a temp dir.
3. Sets up a throwaway scratch directory with a real `git init` and committed initial state.
4. Installs the packed tarballs (with the `pnpm.overrides` workaround — see Known Issues below).
5. Exercises the current command surface: `init`, `doctor`, `--version`, `checkpoint`, `checkpoints`, `start`, `end`, `sessions`.
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

This workaround becomes unnecessary once the packages are published to npm (a v0.7.0-beta release task — not yet scheduled). For now, it is the canonical local-smoke-test pattern.

### 2. PowerShell 5.1 UTF-8 BOM in JSON test fixtures

**Problem.** PowerShell 5.1's `Out-File -Encoding utf8` and `Set-Content -Encoding utf8` both write UTF-8 with a leading BOM (`EF BB BF`). Node's `JSON.parse` rejects files that start with a BOM, producing a `SyntaxError: Unexpected token` error citing the literal BOM character (`U+FEFF`) at JSON position 0.

**Workaround.** For any file Node will read as JSON (`package.json`, fixture JSON, `lock.json`, etc.), write with `[System.IO.File]::WriteAllText` using a `UTF8Encoding` constructed with `$false` (no-BOM):

```powershell
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
```

This affects any .NET-via-PowerShell file write that Node will later parse as JSON. The same pattern applies to any text format that is BOM-sensitive (YAML loaders are mixed; some accept BOM, some don't).

PowerShell 7+ (`pwsh`) defaults `-Encoding utf8` to no-BOM, so this gotcha is specific to PowerShell 5.1. The smoke-test helper script targets PowerShell 5.1 because it is the system PowerShell on Windows 10 and Windows 11 without an explicit `pwsh` install.

## License

Apache-2.0. See the repository `LICENSE` and `NOTICE` files.
