# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Fabio Marcello Salvadori

# VibeRevert M B smoke test.
# Builds + packs the 4 currently pack-tested packages, installs them into a
# scratch dir under $env:TEMP, and exercises the M B command surface against
# a real `git init` repo.
#
# See docs/release-process.md for the workflow rationale and the two known
# release-packaging issues (pnpm.overrides workaround; PowerShell 5.1 BOM).
#
# Usage:
#   powershell.exe -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
#   pwsh -File scripts/smoke-test.ps1
#
# Flags:
#   -KeepArtifacts   Do not clean up temp dirs even on success (debugging aid).
#
# Exit code: 0 on green, 1 on any failure. On failure, prints the packDir and
# scratch paths before exiting so the failure can be inspected.

param(
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'

# --- State -----------------------------------------------------------------

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMddHHmmss'
$suffix = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
$runId = "$timestamp-$suffix"
$packDir = Join-Path $env:TEMP "viberevert-pack-$runId"
$scratch = Join-Path $env:TEMP "viberevert-smoke-$runId"
$cleanupOnExit = $true
$passCount = 0
$failCount = 0
$aborted = $false

# --- Helpers ---------------------------------------------------------------

function Write-Section($title) {
    Write-Host ''
    Write-Host "=== $title ==="
}

function Invoke-Cli {
    # Runs `pnpm exec viberevert <args>` and asserts the exit code.
    # Two PowerShell 5.1 hazards on native-exe interop, both handled here:
    #   1. `2>&1` wraps native stderr lines in ErrorRecord (NativeCommandError)
    #      objects. With $ErrorActionPreference='Stop' (set at script top so
    #      our own helpers fail fast), those ErrorRecords would terminate the
    #      pipeline mid-call, BEFORE we can check $LASTEXITCODE — and every
    #      step that legitimately expects exit 1 (refusal cases) would abort.
    #      Solution: lower $ErrorActionPreference to 'Continue' for the
    #      duration of the call via try/finally so the wrapped stderr is
    #      captured but doesn't throw.
    #   2. `$?` is unreliable after such calls; we always use $LASTEXITCODE
    #      for the actual exit-code assertion.
    param(
        [Parameter(Mandatory)][string[]]$CliArgs,
        [Parameter(Mandatory)][int]$ExpectedExit,
        [Parameter(Mandatory)][string]$StepName
    )
    Write-Host "> pnpm exec viberevert $($CliArgs -join ' ')"
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & pnpm exec viberevert @CliArgs 2>&1
        $actualExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($output) {
        # PowerShell 5.1 wraps native stderr under `2>&1` as ErrorRecord
        # objects. Blank/separator stderr lines can stringify as the type
        # name `System.Management.Automation.RemoteException`, which is not
        # useful smoke output. Normalize ErrorRecord objects through their
        # exception message and suppress blank / placeholder lines.
        $output | ForEach-Object {
            $text = if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $_.Exception.Message
            } else {
                "$_"
            }

            if (
                -not [string]::IsNullOrWhiteSpace($text) -and
                $text -ne 'System.Management.Automation.RemoteException'
            ) {
                Write-Host "  $text"
            }
        }
    }
    if ($actualExit -eq $ExpectedExit) {
        Write-Host "[PASS] $StepName (exit $actualExit)"
        $script:passCount++
    } else {
        Write-Host "[FAIL] $StepName (expected exit $ExpectedExit, got $actualExit)"
        $script:failCount++
        throw "Smoke step failed: $StepName"
    }
}

# --- Pre-flight: required tools on PATH ------------------------------------

Write-Section 'Pre-flight'
foreach ($tool in @('pnpm', 'git', 'node')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "[FAIL] required tool not on PATH: $tool"
        exit 1
    }
    Write-Host "[ok] $tool on PATH"
}

# --- Main flow inside try/finally for guaranteed cleanup -------------------

try {
    # 1. Build the workspace so packed tarballs reflect current source.
    Write-Section 'Build workspace (pnpm build)'
    Push-Location $repoRoot
    try {
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit $LASTEXITCODE)" }
        Write-Host '[ok] pnpm build succeeded'
    } finally {
        Pop-Location
    }

    # 2. Pack the 4 M B packages into $packDir.
    Write-Section "Pack M B packages into $packDir"
    New-Item -ItemType Directory -Force $packDir | Out-Null
    Push-Location $repoRoot
    try {
        & pnpm --filter '@viberevert/session-format' `
               --filter '@viberevert/core' `
               --filter '@viberevert/git' `
               --filter 'viberevert' `
               pack --pack-destination $packDir
        if ($LASTEXITCODE -ne 0) { throw "pnpm pack failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }

    # Resolve packed tarball paths.
    $tgzSf = (Get-ChildItem $packDir -Filter 'viberevert-session-format-*.tgz' | Select-Object -First 1).FullName
    $tgzCo = (Get-ChildItem $packDir -Filter 'viberevert-core-*.tgz' | Select-Object -First 1).FullName
    $tgzGi = (Get-ChildItem $packDir -Filter 'viberevert-git-*.tgz' | Select-Object -First 1).FullName
    # `viberevert-<version>.tgz` — match digit-leading suffix so we don't pick
    # up viberevert-git/core/session-format tarballs (which also start with `viberevert-`).
    # Note: PowerShell/Windows `-Filter` is filesystem-provider filtering, NOT a bash-style
    # glob — character classes like `[0-9]` do NOT work. Use a `Where-Object` regex (.NET regex)
    # via `-match` instead. Sort-Object for deterministic selection if multiple matches ever exist.
    $tgzCl = (Get-ChildItem $packDir -Filter 'viberevert-*.tgz' |
        Where-Object { $_.Name -match '^viberevert-\d' } |
        Sort-Object Name |
        Select-Object -First 1).FullName

    foreach ($tgz in @($tgzSf, $tgzCo, $tgzGi, $tgzCl)) {
        if (-not $tgz) {
            $listed = (Get-ChildItem $packDir).Name -join ', '
            throw "Expected tarball not found under $packDir (files: $listed)"
        }
        Write-Host "  packed: $(Split-Path -Leaf $tgz)"
    }

    # 3. Set up scratch consumer dir with a real git repo.
    Write-Section "Set up scratch dir $scratch + git init"
    New-Item -ItemType Directory -Force $scratch | Out-Null
    Push-Location $scratch
    try {
        & git init --quiet
        if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
        & git config user.name 'Smoke Test'
        & git config user.email 'smoke@example.com'
        & git config commit.gpgsign false

        'hello' | Out-File -FilePath 'README.md' -Encoding ascii
        "node_modules/" | Out-File -FilePath '.gitignore' -Encoding ascii

        & git add README.md .gitignore
        & git commit -q -m 'initial'
        if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
        Write-Host '[ok] scratch dir initialized'

        # 4. Write consumer package.json with pnpm.overrides (release-process.md
        # known issue #1) using UTF-8 no-BOM (known issue #2).
        Write-Section 'Write consumer package.json (UTF-8 no-BOM, pnpm.overrides)'
        # Forward-slash the paths for cleaner JSON (no Windows-backslash escaping).
        $pSf = $tgzSf -replace '\\', '/'
        $pCo = $tgzCo -replace '\\', '/'
        $pGi = $tgzGi -replace '\\', '/'
        $pCl = $tgzCl -replace '\\', '/'

        $packageJson = @"
{
  "name": "viberevert-smoke",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "@viberevert/session-format": "file:$pSf",
    "@viberevert/core": "file:$pCo",
    "@viberevert/git": "file:$pGi",
    "viberevert": "file:$pCl"
  },
  "pnpm": {
    "overrides": {
      "@viberevert/session-format": "file:$pSf",
      "@viberevert/core": "file:$pCo",
      "@viberevert/git": "file:$pGi"
    }
  }
}
"@

        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText((Join-Path $scratch 'package.json'), $packageJson, $utf8NoBom)
        Write-Host '[ok] package.json written (no BOM)'

        # 5. pnpm install
        Write-Section 'pnpm install'
        & pnpm install --silent
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
        Write-Host '[ok] pnpm install succeeded'

        # 6. Exercise the M B command surface.

        Invoke-Cli -CliArgs @('--version') -ExpectedExit 0 -StepName 'version'
        Invoke-Cli -CliArgs @('doctor') -ExpectedExit 0 -StepName 'doctor'
        Invoke-Cli -CliArgs @('checkpoints') -ExpectedExit 0 -StepName 'checkpoints-pre-init'
        Invoke-Cli -CliArgs @('sessions') -ExpectedExit 0 -StepName 'sessions-pre-init'
        Invoke-Cli -CliArgs @('init', '--profile', 'generic') -ExpectedExit 0 -StepName 'init'

        # Verify .viberevert/ is gitignored after init (M B hard precondition).
        Write-Section 'Verify .viberevert/ is gitignored'
        & git check-ignore -q .viberevert/foo
        if ($LASTEXITCODE -ne 0) {
            throw '.viberevert/ is NOT gitignored after init (M B precondition violation)'
        }
        Write-Host '[ok] .viberevert/ gitignored'

        Invoke-Cli -CliArgs @('checkpoint', '--name', 'smoke-baseline') -ExpectedExit 0 -StepName 'checkpoint-create'

        # Verify the checkpoint dir exists under the locked ID-based path.
        $checkpointDirs = Get-ChildItem '.viberevert/checkpoints' -Directory -Filter 'cp_*' -ErrorAction SilentlyContinue
        if (-not $checkpointDirs -or $checkpointDirs.Count -ne 1) {
            throw "Expected exactly one .viberevert/checkpoints/cp_* dir; found $($checkpointDirs.Count)"
        }
        if (-not (Test-Path (Join-Path $checkpointDirs[0].FullName 'manifest.json'))) {
            throw 'manifest.json missing from checkpoint dir'
        }
        Write-Host "[ok] checkpoint dir: $($checkpointDirs[0].Name)/manifest.json present"

        Invoke-Cli -CliArgs @('checkpoints') -ExpectedExit 0 -StepName 'checkpoints-after-create'
        Invoke-Cli -CliArgs @('checkpoint', '--name', 'smoke-baseline') -ExpectedExit 1 -StepName 'checkpoint-name-collision'
        Invoke-Cli -CliArgs @('start', '--task', 'smoke session') -ExpectedExit 0 -StepName 'start'

        # Verify active-session lock is present.
        if (-not (Test-Path '.viberevert/active-session.json')) {
            throw '.viberevert/active-session.json missing after `start`'
        }
        Write-Host '[ok] active-session.json present'

        Invoke-Cli -CliArgs @('sessions') -ExpectedExit 0 -StepName 'sessions-active'
        Invoke-Cli -CliArgs @('start', '--task', 'another') -ExpectedExit 1 -StepName 'start-refused-active'
        Invoke-Cli -CliArgs @('end') -ExpectedExit 0 -StepName 'end'

        # Verify active-session lock was cleared.
        if (Test-Path '.viberevert/active-session.json') {
            throw '.viberevert/active-session.json still present after `end`'
        }
        Write-Host '[ok] active-session.json cleared'

        Invoke-Cli -CliArgs @('end') -ExpectedExit 1 -StepName 'end-refused-no-session'
        Invoke-Cli -CliArgs @('sessions') -ExpectedExit 0 -StepName 'sessions-ended'

    } finally {
        Pop-Location
    }

    Write-Section 'Summary'
    Write-Host "CLI steps passed: $passCount"
    Write-Host "CLI steps failed: $failCount"
    Write-Host '[ALL PASS] M B smoke test green.'

} catch {
    $aborted = $true
    $cleanupOnExit = $false
    Write-Host ''
    Write-Host "[ABORT] $_"
} finally {
    if ($cleanupOnExit -and -not $KeepArtifacts) {
        Write-Host ''
        Write-Host 'Cleaning up temp directories...'
        if (Test-Path $packDir) { Remove-Item -Recurse -Force $packDir -ErrorAction SilentlyContinue }
        if (Test-Path $scratch) { Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue }
        Write-Host 'Cleanup complete.'
    } else {
        Write-Host ''
        Write-Host 'Temp directories preserved for inspection:'
        Write-Host "  packDir: $packDir"
        Write-Host "  scratch: $scratch"
    }
    if ($aborted -or $failCount -gt 0) { exit 1 }
}

exit 0
