# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Fabio Marcello Salvadori

# VibeRevert local tarball-closure smoke test.
#
# Builds + packs every workspace package whose tarball is needed to satisfy
# the published CLI's runtime closure -- the public runtime packages, the
# CLI entry-point, and any currently-private workspace package that a
# publishable package depends on (M G1b Step 1b added @viberevert/adapters here).
# Installs them into a scratch dir under $env:TEMP via `file:` references
# + pnpm.overrides and exercises the M B + M C + M D + M E + M F command
# surface (Phases 12a-12e) against a real `git init` repo.
#
# Validates the LOCAL TARBALL DEPENDENCY CLOSURE. Must not fall back to
# npm for any @viberevert/* package -- a guard near the overrides JSON
# enforces this (see "Verify local-tarball-closure invariant" below).
# Public registry install is a separate post-publish flow, not this
# script's responsibility.
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
    # Runs `pnpm exec viberevert <args>` and asserts the exit code (and
    # optionally that captured output contains a specific substring).
    # Two PowerShell 5.1 hazards on native-exe interop, both handled here:
    #   1. `2>&1` wraps native stderr lines in ErrorRecord (NativeCommandError)
    #      objects. With $ErrorActionPreference='Stop' (set at script top so
    #      our own helpers fail fast), those ErrorRecords would terminate the
    #      pipeline mid-call, BEFORE we can check $LASTEXITCODE -- and every
    #      step that legitimately expects exit 1 (refusal cases) would abort.
    #      Solution: lower $ErrorActionPreference to 'Continue' for the
    #      duration of the call via try/finally so the wrapped stderr is
    #      captured but doesn't throw.
    #   2. `$?` is unreliable after such calls; we always use $LASTEXITCODE
    #      for the actual exit-code assertion.
    #
    # ExpectedOutputContains (optional) locks the user-facing error/output
    # copy in addition to the exit code. Combined exit-AND-content check
    # so pass/fail counters stay coherent (one PASS or one FAIL per step,
    # never both).
    param(
        [Parameter(Mandatory)][string[]]$CliArgs,
        [Parameter(Mandatory)][int]$ExpectedExit,
        [Parameter(Mandatory)][string]$StepName,
        [string]$ExpectedOutputContains
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
    # Normalize output lines for both display and the optional
    # substring assertion. ErrorRecord objects need their exception
    # message extracted; PowerShell 5.1's `2>&1` synthetic
    # 'System.Management.Automation.RemoteException' lines are filtered.
    $normalizedLines = @()
    if ($output) {
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
                $normalizedLines += $text
            }
        }
    }
    $exitMatches = ($actualExit -eq $ExpectedExit)
    $contentMatches = $true
    if ($PSBoundParameters.ContainsKey('ExpectedOutputContains')) {
        $joined = $normalizedLines -join "`n"
        $contentMatches = $joined.Contains($ExpectedOutputContains)
    }
    if ($exitMatches -and $contentMatches) {
        Write-Host "[PASS] $StepName (exit $actualExit)"
        $script:passCount++
    } else {
        if (-not $exitMatches) {
            Write-Host "[FAIL] $StepName (expected exit $ExpectedExit, got $actualExit)"
        }
        if (-not $contentMatches) {
            Write-Host "[FAIL] $StepName output did not contain expected substring: $ExpectedOutputContains"
        }
        $script:failCount++
        throw "Smoke step failed: $StepName"
    }
}

function Invoke-CliCaptureStdout {
    # Truly byte-level stdout capture via System.Diagnostics.Process,
    # with stdout AND stderr drained concurrently to prevent
    # pipe-buffer deadlock.
    #
    # Why a separate helper from Invoke-Cli:
    # Invoke-Cli uses `2>&1` + ErrorRecord normalization +
    # Write-Host for refusal-style assertions -- right for those
    # cases, but would corrupt a D81 byte-identity comparison.
    # This helper keeps stdout in its own stream and reads it as
    # raw bytes via StandardOutput.BaseStream.CopyToAsync --
    # PowerShell 5.1's native `1>$file` redirection has known
    # host-dependent transcoding/normalization quirks for native
    # commands, so the .NET API is the only path guaranteed
    # byte-clean.
    #
    # Concurrent draining: stdout via CopyToAsync to a MemoryStream,
    # stderr via ReadToEndAsync to a string Task. Both Tasks start
    # before WaitForExit so the child can write to either stream
    # without filling the OS pipe buffer (4KB on Windows).
    # Sequential reads (stdout fully then stderr) would deadlock
    # if the child wrote >4KB of stderr before closing stdout.
    #
    # Returns a PSCustomObject with three fields:
    #   StdoutBytes (byte[]) -- raw stdout, byte-identical to what
    #                          the child process wrote
    #   StderrText  (string) -- stderr decoded as text, for
    #                          diagnostic display AND caller-side
    #                          assertions (e.g., "success path must
    #                          have empty stderr"). The helper
    #                          displays stderr but does NOT assert
    #                          on it -- semantics vary per caller.
    #   ExitCode    (int)    -- process exit code (already asserted
    #                          to match $ExpectedExit before return)
    param(
        [Parameter(Mandatory)][string[]]$CliArgs,
        [Parameter(Mandatory)][int]$ExpectedExit,
        [Parameter(Mandatory)][string]$StepName
    )

    # Defensive: our CliArgs in this smoke are simple (flag names,
    # ULIDs, literal strings -- no whitespace). cmd.exe arg-joining
    # below is space-naive; a future arg with embedded whitespace
    # would need explicit quoting. Fail loudly here so the
    # limitation surfaces at the call site, not silently downstream.
    foreach ($a in $CliArgs) {
        if ($a -match '\s') {
            throw "Invoke-CliCaptureStdout: arg '$a' contains whitespace; cmd.exe arg-joining is space-naive. Add explicit quoting at the helper site if this becomes needed."
        }
    }

    # Wrap via cmd.exe because pnpm on Windows is `pnpm.cmd`, which
    # CreateProcess (UseShellExecute=$false) can't launch directly.
    # The wrapper costs one shell hop; the byte path through pnpm
    # and node is unchanged.
    $argsString = "/c pnpm exec viberevert $($CliArgs -join ' ')"

    Write-Host "> pnpm exec viberevert $($CliArgs -join ' ') (Process.StandardOutput.BaseStream raw bytes, concurrent stderr drain)"

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec
    $psi.Arguments = $argsString
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = (Get-Location).Path

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $null = $proc.Start()

    # Drain BOTH streams concurrently. Tasks start before
    # WaitForExit so the child can fill either pipe without
    # blocking. Wait() on both Tasks AFTER WaitForExit guarantees
    # we've consumed everything before reading the buffers.
    $ms = New-Object System.IO.MemoryStream
    try {
        $stdoutTask = $proc.StandardOutput.BaseStream.CopyToAsync($ms)
        $stderrTask = $proc.StandardError.ReadToEndAsync()
        $proc.WaitForExit()
        $stdoutTask.Wait()
        $stderrTask.Wait()

        $stdoutBytes = $ms.ToArray()
        $stderrText = $stderrTask.Result
        $actualExit = $proc.ExitCode
    } finally {
        $ms.Dispose()
        $proc.Dispose()
    }

    # Display stderr for diagnostic -- does NOT assert. Callers
    # enforce per-path stderr semantics (e.g., Phase 12d success
    # path asserts $.StderrText -eq '').
    if (-not [string]::IsNullOrEmpty($stderrText)) {
        Write-Host "  [stderr] $stderrText"
    }
    if ($actualExit -ne $ExpectedExit) {
        Write-Host "[FAIL] $StepName (expected exit $ExpectedExit, got $actualExit)"
        $script:failCount++
        throw "Smoke step failed: $StepName"
    }
    Write-Host "[PASS] $StepName (exit $actualExit, $($stdoutBytes.Length) bytes stdout, $($stderrText.Length) bytes stderr)"
    $script:passCount++

    return [PSCustomObject]@{
        StdoutBytes = $stdoutBytes
        StderrText  = $stderrText
        ExitCode    = $actualExit
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

$rootPackage = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$rootPackageManager = [string]$rootPackage.packageManager
if ([string]::IsNullOrWhiteSpace($rootPackageManager)) {
    Write-Host "[FAIL] root package.json missing 'packageManager' field (cannot derive scratch pnpm pin under Corepack)"
    exit 1
}
if (-not $rootPackageManager.StartsWith('pnpm@')) {
    Write-Host "[FAIL] root package.json packageManager must be a pnpm pin for smoke scratch install: $rootPackageManager"
    exit 1
}
Write-Host "[ok] root package.json packageManager=$rootPackageManager"

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

    # 2. Pack every workspace package needed by the local tarball closure into $packDir.
    Write-Section "Pack publishable packages into $packDir"
    New-Item -ItemType Directory -Force $packDir | Out-Null
    Push-Location $repoRoot
    try {
        & pnpm --filter '@viberevert/session-format' `
               --filter '@viberevert/core' `
               --filter '@viberevert/git' `
               --filter '@viberevert/checks' `
               --filter '@viberevert/reporters' `
               --filter '@viberevert/adapters' `
               --filter '@viberevert/installers' `
               --filter '@viberevert/cli-commands' `
               --filter '@viberevert/mcp' `
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
    $tgzCh = (Get-ChildItem $packDir -Filter 'viberevert-checks-*.tgz' | Select-Object -First 1).FullName
    $tgzRe = (Get-ChildItem $packDir -Filter 'viberevert-reporters-*.tgz' | Select-Object -First 1).FullName
    $tgzCc = (Get-ChildItem $packDir -Filter 'viberevert-cli-commands-*.tgz' | Select-Object -First 1).FullName
    $tgzMc = (Get-ChildItem $packDir -Filter 'viberevert-mcp-*.tgz' | Select-Object -First 1).FullName
    # Step 1b: adapters tarball (packed but private at 0.0.0; resolved via
    # pnpm.overrides below so cli-commands' workspace dep on it doesn't
    # fall back to npm).
    $tgzAd = (Get-ChildItem $packDir -Filter 'viberevert-adapters-*.tgz' | Select-Object -First 1).FullName
    # M G1b Step 4: installers tarball (packed but private at 0.0.0; resolved
    # via pnpm.overrides below so cli-commands' workspace dep on it doesn't
    # fall back to npm).
    $tgzIn = (Get-ChildItem $packDir -Filter 'viberevert-installers-*.tgz' | Select-Object -First 1).FullName
    # `viberevert-<version>.tgz` -- match digit-leading suffix so we don't pick
    # up viberevert-git/core/session-format/checks/reporters/cli-commands/mcp
    # tarballs (which also start with `viberevert-`). cli-commands is post-Step-1
    # (M G1a Step 1); mcp is post-Step-4 (M G1a Step 4).
    # Note: PowerShell/Windows `-Filter` is filesystem-provider filtering, NOT a bash-style
    # glob -- character classes like `[0-9]` do NOT work. Use a `Where-Object` regex (.NET regex)
    # via `-match` instead. Sort-Object for deterministic selection if multiple matches ever exist.
    $tgzCl = (Get-ChildItem $packDir -Filter 'viberevert-*.tgz' |
        Where-Object { $_.Name -match '^viberevert-\d' } |
        Sort-Object Name |
        Select-Object -First 1).FullName

    foreach ($tgz in @($tgzSf, $tgzCo, $tgzGi, $tgzCh, $tgzRe, $tgzAd, $tgzIn, $tgzCc, $tgzMc, $tgzCl)) {
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
        #
        # Local-tarball-closure rule: if a packed @viberevert/* package depends
        # on another workspace package, that dependency MUST be listed in the
        # pnpm.overrides block below. Otherwise scratch install will fall
        # back to npm and either fail (404 for unpublished packages like
        # @viberevert/adapters pre-Step-8) or, worse, silently resolve a
        # stale public version. The guard right after this block enforces
        # it; keep them in sync when adding a new workspace edge.
        Write-Section 'Write consumer package.json (UTF-8 no-BOM, pnpm.overrides)'
        # Forward-slash the paths for cleaner JSON (no Windows-backslash escaping).
        $pSf = $tgzSf -replace '\\', '/'
        $pCo = $tgzCo -replace '\\', '/'
        $pGi = $tgzGi -replace '\\', '/'
        $pCh = $tgzCh -replace '\\', '/'
        $pRe = $tgzRe -replace '\\', '/'
        $pCc = $tgzCc -replace '\\', '/'
        $pMc = $tgzMc -replace '\\', '/'
        $pAd = $tgzAd -replace '\\', '/'
        $pIn = $tgzIn -replace '\\', '/'
        $pCl = $tgzCl -replace '\\', '/'

        $packageJson = @"
{
  "name": "viberevert-smoke",
  "version": "0.0.0",
  "private": true,
  "packageManager": "$rootPackageManager",
  "dependencies": {
    "@viberevert/session-format": "file:$pSf",
    "@viberevert/core": "file:$pCo",
    "@viberevert/git": "file:$pGi",
    "@viberevert/checks": "file:$pCh",
    "@viberevert/reporters": "file:$pRe",
    "viberevert": "file:$pCl"
  },
  "pnpm": {
    "overrides": {
      "@viberevert/session-format": "file:$pSf",
      "@viberevert/core": "file:$pCo",
      "@viberevert/git": "file:$pGi",
      "@viberevert/checks": "file:$pCh",
      "@viberevert/reporters": "file:$pRe",
      "@viberevert/adapters": "file:$pAd",
      "@viberevert/installers": "file:$pIn",
      "@viberevert/cli-commands": "file:$pCc",
      "@viberevert/mcp": "file:$pMc"
    }
  }
}
"@

        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText((Join-Path $scratch 'package.json'), $packageJson, $utf8NoBom)
        Write-Host '[ok] package.json written (no BOM)'

        # Verify local-tarball-closure invariant: every packed @viberevert/*
        # package MUST appear as a key in pnpm.overrides. If a package is
        # missing here, pnpm install would fall back to npm for it -- failing
        # (404 for private packages) or, post-publish, silently resolving a
        # stale public version. The CLI entry-point `viberevert` is
        # deliberately NOT in overrides (installed via `dependencies`).
        $packedInternalPackages = @(
            '@viberevert/session-format',
            '@viberevert/core',
            '@viberevert/git',
            '@viberevert/checks',
            '@viberevert/reporters',
            '@viberevert/adapters',
            '@viberevert/installers',
            '@viberevert/cli-commands',
            '@viberevert/mcp'
        )
        $writtenPkgJson = Get-Content (Join-Path $scratch 'package.json') -Raw | ConvertFrom-Json
        $actualOverrideKeys = @($writtenPkgJson.pnpm.overrides.PSObject.Properties.Name)
        foreach ($pkg in $packedInternalPackages) {
            if ($actualOverrideKeys -notcontains $pkg) {
                throw "Local-tarball-closure invariant violated: '$pkg' is packed but not listed in pnpm.overrides. Scratch install would fall back to npm. Add an override entry above."
            }
        }
        Write-Host '[ok] local-tarball-closure invariant: all packed @viberevert/* packages covered by overrides'

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

        # 7. M C Phase 12a: basic check + report scenarios from packed install.
        # These prove the new package graph (checks + reporters added in M C)
        # works end-to-end against the published CLI binary, against a real
        # checkpoint base. State at entry: no active session, smoke-baseline
        # checkpoint exists, working tree is clean.

        Write-Section 'M C 12a: boring edit + check (expect zero findings, exit 0)'
        # Append a boring documentation line to README.md. README.md matches
        # no path-classifier rule and contains no detector triggers, so the
        # check should produce zero findings.
        Add-Content -Path 'README.md' -Value 'Boring documentation edit.' -Encoding ascii
        Invoke-Cli -CliArgs @('check', '--since', 'smoke-baseline') -ExpectedExit 0 -StepName 'check-boring-zero-findings'

        Write-Section 'M C 12a: risky edit + check --json (expect critical secret, exit 2)'
        # Add a Python file with an ENV-style synthetic secret literal. The
        # TESTFIXTUREONLY_ prefix ensures the value is obviously not a real
        # credential and won't trip GitHub Push Protection on push. The
        # detector emits a critical secrets.regex finding which trips the
        # default block_on=critical gate.
        New-Item -ItemType Directory -Force 'src' | Out-Null
        $secretPyContent = @'
"""Application config."""

APP_API_KEY = "TESTFIXTUREONLY_S9qX8wV7tS6rP5nM4kL3jH2gF1"
'@
        $secretPyContent | Out-File -FilePath 'src/config.py' -Encoding ascii
        Invoke-Cli -CliArgs @('check', '--since', 'smoke-baseline', '--json') -ExpectedExit 2 -StepName 'check-risky-exit-2-json'

        Write-Section 'M C 12a: report variants'
        # `viberevert report` defaults to terminal output, reads the most
        # recent persisted report via D47 resolution. Exit 0 for a read-only
        # render -- the report's findings do NOT affect this command's exit
        # code (only `check` gates).
        Invoke-Cli -CliArgs @('report') -ExpectedExit 0 -StepName 'report-terminal'
        Invoke-Cli -CliArgs @('report', '--markdown') -ExpectedExit 0 -StepName 'report-markdown'
        Invoke-Cli -CliArgs @('report', '--json') -ExpectedExit 0 -StepName 'report-json'

        # 8. M C Phase 12b: targeted packed-install proofs for high-value
        # M C package-boundary paths. Smoke tests cover package-boundary
        # failure modes, NOT duplicate behavioral coverage proven byte-stably
        # in golden fixtures.

        Write-Section 'M C 12b: report --threshold packed filter'
        # Run this before the D56 zero-finding check overwrites the latest
        # persisted report. The latest report is still the Phase 12a critical
        # secrets report, so threshold filtering is exercised on meaningful data.
        Invoke-Cli -CliArgs @('report', '--threshold', 'high') -ExpectedExit 0 -StepName 'report-threshold-high'

        Write-Section 'M C 12b: D56 dirty-checkpoint packed proof'
        # Capture the current dirty working tree: README.md modified and
        # src/config.py untracked with a critical synthetic secret from Phase 12a.
        Invoke-Cli -CliArgs @('checkpoint', '--name', 'dirty-base') -ExpectedExit 0 -StepName 'checkpoint-create-with-dirt'

        # Add a boring post-checkpoint change. Correct D56 behavior excludes
        # the pre-existing dirty secret, so this check exits 0. If the dirty
        # checkpoint machinery regresses and src/config.py leaks into the diff,
        # the critical secret finding makes this exit 2 and the smoke test fails.
        New-Item -ItemType Directory -Force 'docs' | Out-Null
        'Post-checkpoint boring documentation change.' | Out-File -FilePath 'docs/d56-note.md' -Encoding ascii
        Invoke-Cli -CliArgs @('check', '--since', 'dirty-base') -ExpectedExit 0 -StepName 'check-d56-dirty-base-excludes-preexisting-dirt'

        Write-Section 'M C 12b: D58 --staged + checkpoint mutual exclusion'
        Invoke-Cli -CliArgs @('check', '--staged', '--since', 'smoke-baseline') -ExpectedExit 1 -StepName 'check-staged-plus-checkpoint-name-refused'

        # 9. M D Phase 12c: rollback dry-run + apply + idempotency.
        # Runs BEFORE the missing-config "LAST scenario" block because
        # rollback requires a valid .viberevert.yml (D19 config-required).
        # Proves the new M D rollback command end-to-end:
        #   - clean git baseline before session start (no D61 ambiguity)
        #   - dry-run produces a receipt without mutating
        #   - apply restores tracked content AND removes session-created files
        #   - apply writes its own receipt + preserves the dry-run receipt
        #     byte-identically (D68 path-split)
        #   - the emergency pre-rollback checkpoint is created and referenced
        #   - re-applying triggers the D70 already-applied refusal with the
        #     locked copy AND no new state (no new checkpoint, no apply-
        #     receipt mutation, no leaked lock)

        Write-Section 'M D 12c: prepare rollback baseline'

        # Commit everything from prior phases so Phase 12c starts from a
        # clean git baseline. Without this, the dirty state from Phase
        # 12a/12b (README.md modified, src/config.py untracked, etc.)
        # would interact with D61's expected-dirt computation in ways
        # that are hard to reason about within a smoke proof.
        & git add -A
        if ($LASTEXITCODE -ne 0) { throw 'git add -A failed before rollback smoke phase' }
        & git commit --allow-empty -q -m 'smoke rollback baseline'
        if ($LASTEXITCODE -ne 0) { throw 'git commit failed before rollback smoke phase' }

        $preRollbackStatus = & git status --porcelain
        if ($preRollbackStatus) {
            throw "expected clean git status before rollback smoke phase, got:`n$preRollbackStatus"
        }
        Write-Host '[ok] rollback smoke phase starts from clean git baseline'

        # Create a TRACKED baseline file. Will be modified during the
        # session; apply should restore this exact content (the harder
        # restore semantic -- untracked-only deletion is insufficient
        # coverage).
        'baseline tracked rollback content' | Out-File -FilePath 'tracked-rollback.txt' -Encoding ascii
        & git add tracked-rollback.txt
        if ($LASTEXITCODE -ne 0) { throw 'git add tracked-rollback.txt failed' }
        & git commit -q -m 'smoke rollback tracked baseline'
        if ($LASTEXITCODE -ne 0) { throw 'git commit of tracked-rollback.txt failed' }

        $trackedBaselineStatus = & git status --porcelain
        if ($trackedBaselineStatus) {
            throw "expected clean git status after tracked rollback baseline commit, got:`n$trackedBaselineStatus"
        }
        Write-Host '[ok] tracked rollback baseline committed cleanly'

        Write-Section 'M D 12c: rollback dry-run + apply + idempotency'

        # Start a fresh session against the clean baseline.
        Invoke-Cli -CliArgs @('start', '--task', 'smoke rollback') -ExpectedExit 0 -StepName 'rollback-start-session'

        # Capture the session id from active-session.json (more robust
        # than parsing stdout). Verify it has the locked sess_<ULID> shape.
        $activeSessionPath = '.viberevert/active-session.json'
        if (-not (Test-Path $activeSessionPath)) {
            throw 'active-session.json not present after `viberevert start`'
        }
        $sessionId = (Get-Content $activeSessionPath -Raw | ConvertFrom-Json).session_id
        if (-not ($sessionId -match '^sess_[0-9A-HJKMNP-TV-Z]{26}$')) {
            throw "could not parse sess_<ULID> from active-session.json (got: $sessionId)"
        }
        Write-Host "[ok] captured session id: $sessionId"

        # Two changes during the session:
        #   - Modify the tracked file (apply should restore it to baseline).
        #   - Create an untracked file (apply should remove it).
        'session modified tracked rollback content' | Out-File -FilePath 'tracked-rollback.txt' -Encoding ascii
        'Smoke rollback file - to be removed by --apply.' | Out-File -FilePath 'smoke-rollback.txt' -Encoding ascii

        # End the session. Captures after-status with both changes.
        Invoke-Cli -CliArgs @('end') -ExpectedExit 0 -StepName 'rollback-end-session'

        # Dry-run rollback. Receipt at the dry-run D68 path; no mutation.
        Invoke-Cli -CliArgs @('rollback', $sessionId) -ExpectedExit 0 -StepName 'rollback-dry-run'

        # Lock cleanup (D67): rollback should remove its own lock on exit.
        if (Test-Path '.viberevert/.locks/rollback.lock') {
            throw 'rollback lock leaked after dry-run'
        }
        Write-Host '[ok] rollback lock cleaned up after dry-run'

        $dryRunReceiptPath = ".viberevert/sessions/$sessionId/rollback-dry-run-receipt.json"
        if (-not (Test-Path $dryRunReceiptPath)) {
            throw "dry-run receipt missing at $dryRunReceiptPath"
        }
        Write-Host "[ok] dry-run receipt persisted at $dryRunReceiptPath"

        # Parse + assert dry-run receipt shape (D69 schema).
        $dryRunReceipt = Get-Content $dryRunReceiptPath -Raw | ConvertFrom-Json
        if ($dryRunReceipt.mode -ne 'dry_run') {
            throw "dry-run receipt mode mismatch: got $($dryRunReceipt.mode)"
        }
        if ($null -ne $dryRunReceipt.pre_rollback_checkpoint_id) {
            throw "dry-run receipt should not have pre_rollback_checkpoint_id (got: $($dryRunReceipt.pre_rollback_checkpoint_id))"
        }
        Write-Host '[ok] dry-run receipt shape locked (mode=dry_run, pre_rollback_checkpoint_id=null)'

        # D68 path-split (inverse check): dry-run must NOT have created the
        # apply receipt path. Defined here once and reused for the later
        # post-apply existence check.
        $applyReceiptPath = ".viberevert/sessions/$sessionId/rollback-receipt.json"
        if (Test-Path $applyReceiptPath) {
            throw "apply receipt should not exist after dry-run at $applyReceiptPath"
        }
        Write-Host '[ok] dry-run did not create apply receipt path (D68)'

        # Dry-run is inspection-only: smoke-rollback.txt must still exist
        # AND tracked-rollback.txt must still be in its session-modified form.
        if (-not (Test-Path 'smoke-rollback.txt')) {
            throw 'smoke-rollback.txt should still exist after dry-run (no mutation)'
        }
        $trackedAfterDryRun = Get-Content 'tracked-rollback.txt' -Raw
        if ($trackedAfterDryRun -notmatch '^session modified tracked rollback content\r?\n?$') {
            throw "tracked-rollback.txt should remain session-modified after dry-run. Got: $trackedAfterDryRun"
        }
        Write-Host '[ok] dry-run did not mutate tracked or untracked working-tree state'

        # Capture dry-run receipt bytes BEFORE apply, so we can later
        # assert apply preserved them byte-identically (D68 path-split).
        $dryRunReceiptBytesBeforeApply = Get-Content $dryRunReceiptPath -Raw

        # Apply rollback. Receipt at the apply D68 path; tracked file
        # restored to baseline; smoke-rollback.txt removed.
        Invoke-Cli -CliArgs @('rollback', $sessionId, '--apply') -ExpectedExit 0 -StepName 'rollback-apply'

        # Lock cleanup (D67).
        if (Test-Path '.viberevert/.locks/rollback.lock') {
            throw 'rollback lock leaked after apply'
        }
        Write-Host '[ok] rollback lock cleaned up after apply'

        if (-not (Test-Path $applyReceiptPath)) {
            throw "apply receipt missing at $applyReceiptPath"
        }
        Write-Host "[ok] apply receipt persisted at $applyReceiptPath"

        # Parse + assert apply receipt shape (D69 schema + Lock #16).
        $applyReceipt = Get-Content $applyReceiptPath -Raw | ConvertFrom-Json
        if ($applyReceipt.mode -ne 'apply') {
            throw "apply receipt mode mismatch: got $($applyReceipt.mode)"
        }
        if ($applyReceipt.forced -ne $false) {
            throw "apply receipt should have forced=false for non-force smoke apply, got: $($applyReceipt.forced)"
        }
        if ($applyReceipt.failures.Count -ne 0) {
            throw "apply receipt should have no failures, got: $($applyReceipt.failures | ConvertTo-Json -Depth 10)"
        }
        Write-Host '[ok] apply receipt shape locked (mode=apply, forced=false, failures empty)'

        # D68 path-split: dry-run receipt preserved byte-identically across apply.
        if (-not (Test-Path $dryRunReceiptPath)) {
            throw "dry-run receipt was removed by apply at $dryRunReceiptPath (D68 path-split violated)"
        }
        $dryRunReceiptBytesAfterApply = Get-Content $dryRunReceiptPath -Raw
        if ($dryRunReceiptBytesAfterApply -ne $dryRunReceiptBytesBeforeApply) {
            throw 'dry-run receipt changed during apply; D68 byte-preservation violated'
        }
        Write-Host '[ok] dry-run receipt preserved byte-identically across apply (D68)'

        # smoke-rollback.txt removed by apply (session-created untracked file).
        if (Test-Path 'smoke-rollback.txt') {
            throw 'smoke-rollback.txt should have been removed by apply'
        }
        Write-Host '[ok] smoke-rollback.txt removed by apply'

        # tracked-rollback.txt restored to baseline content (the harder
        # semantic -- proves restore actually works on tracked files).
        $trackedAfterApply = Get-Content 'tracked-rollback.txt' -Raw
        if ($trackedAfterApply -notmatch '^baseline tracked rollback content\r?\n?$') {
            throw "tracked-rollback.txt was not restored to baseline after apply. Got: $trackedAfterApply"
        }
        Write-Host '[ok] tracked-rollback.txt restored to baseline by apply'

        # Verify pre-rollback emergency checkpoint (D65) exists. The
        # apply receipt's pre_rollback_checkpoint_id field names it.
        $preRollbackCpId = $applyReceipt.pre_rollback_checkpoint_id
        if (-not ($preRollbackCpId -match '^cp_[0-9A-HJKMNP-TV-Z]{26}$')) {
            throw "apply receipt has invalid pre_rollback_checkpoint_id: $preRollbackCpId"
        }
        $emergencyCpDir = ".viberevert/checkpoints/$preRollbackCpId"
        if (-not (Test-Path $emergencyCpDir)) {
            throw "pre-rollback emergency checkpoint missing at $emergencyCpDir"
        }
        Write-Host "[ok] pre-rollback emergency checkpoint persisted at $emergencyCpDir"

        # Capture state BEFORE re-apply so we can assert D70 refuses
        # before any mutation (no new checkpoint, no apply-receipt change).
        $checkpointCountBeforeReapply = @(Get-ChildItem '.viberevert/checkpoints' -Directory -Filter 'cp_*').Count
        $applyReceiptBytesBeforeReapply = Get-Content $applyReceiptPath -Raw

        # D70 idempotency: re-applying must refuse with exit 1 AND
        # surface the locked "already been rolled back" copy.
        Invoke-Cli -CliArgs @('rollback', $sessionId, '--apply') `
            -ExpectedExit 1 `
            -StepName 'rollback-reapply-refused' `
            -ExpectedOutputContains 'already been rolled back'

        # Lock cleanup (D67) on refusal path too.
        if (Test-Path '.viberevert/.locks/rollback.lock') {
            throw 'rollback lock leaked after re-apply refusal'
        }
        Write-Host '[ok] rollback lock cleaned up after re-apply refusal'

        # D70 must refuse BEFORE any mutation: no new emergency CP
        # created, apply receipt unchanged byte-for-byte.
        $checkpointCountAfterReapply = @(Get-ChildItem '.viberevert/checkpoints' -Directory -Filter 'cp_*').Count
        if ($checkpointCountAfterReapply -ne $checkpointCountBeforeReapply) {
            throw "re-apply refusal created a new checkpoint (count went from $checkpointCountBeforeReapply to $checkpointCountAfterReapply); D70 should refuse before D65 emergency CP creation"
        }
        Write-Host '[ok] re-apply refusal did not create a new emergency checkpoint'

        $applyReceiptBytesAfterReapply = Get-Content $applyReceiptPath -Raw
        if ($applyReceiptBytesAfterReapply -ne $applyReceiptBytesBeforeReapply) {
            throw 're-apply refusal changed the apply receipt; D70 pre-mutation guarantee violated'
        }
        Write-Host '[ok] re-apply refusal did not mutate the apply receipt'

        Write-Section 'M E 12d: prompt-fix (deliberate fresh-report + byte-identity + --llm precedence)'

        # Step 1: Create a fresh risk-bearing file using the EXACT
        # proven Phase 12a secret value + Python file pattern, with
        # a distinct filename + constant identifier so this finding
        # is unambiguously Phase 12d's contribution (not Phase 12a's
        # src/config.py finding that survives rollback).
        #
        # Write via [System.IO.File]::WriteAllText with
        # UTF8Encoding($false) -- explicit UTF-8 NO BOM. PowerShell
        # 5.1's Set-Content defaults to the active code page
        # (Windows-1252 often), and Out-File can inject a BOM on
        # some hosts; the .NET API is the bytewise-deterministic
        # path.
        New-Item -ItemType Directory -Force 'src' | Out-Null
        $riskFileContent = @'
"""Smoke Phase 12d trigger."""

PHASE_12D_TOKEN = "TESTFIXTUREONLY_S9qX8wV7tS6rP5nM4kL3jH2gF1"
'@
        $riskFilePath = Join-Path (Get-Location).Path 'src/smoke-12d-trigger.py'
        [System.IO.File]::WriteAllText(
            $riskFilePath,
            $riskFileContent,
            (New-Object System.Text.UTF8Encoding($false))
        )

        # Step 2: Snapshot existing report.json files BEFORE the
        # fresh check, so Step 3's set-difference identifies the
        # NEW report deterministically -- without relying on the
        # resolver's "latest by written_at DESC" sort which could
        # pick the wrong report under timestamp ties (real wall-
        # clock + second precision can tie when checks run rapidly)
        # OR if the resolver drifts.
        $reportsBefore = @(
            Get-ChildItem -Path '.viberevert/sessions/*/report.json', `
                                '.viberevert/reports/*/report.json' `
                -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
        )

        # Step 3: Run check --since smoke-baseline --json (exit 2
        # on the critical secret per block_on=critical).
        Invoke-Cli -CliArgs @('check', '--since', 'smoke-baseline', '--json') `
            -ExpectedExit 2 -StepName 'prompt-fix-check-risky'

        # Identify the new report by set-difference.
        $reportsAfter = @(
            Get-ChildItem -Path '.viberevert/sessions/*/report.json', `
                                '.viberevert/reports/*/report.json' `
                -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
        )
        $newReports = @($reportsAfter | Where-Object { $reportsBefore -notcontains $_ })
        if ($newReports.Count -ne 1) {
            throw "Expected EXACTLY 1 new report.json after fresh check, found $($newReports.Count): $($newReports -join ', ')"
        }
        $newReportPath = $newReports[0]

        # Parse the new report's id from JSON. Lightweight extraction
        # -- full schema validation belongs in golden fixtures; the
        # smoke just needs report_id for the downstream assertions.
        $newReportData = Get-Content -Path $newReportPath -Raw | ConvertFrom-Json
        $newReportId = $newReportData.report_id
        if (-not ($newReportId -match '^(rpt_|sess_)[0-9A-HJKMNP-TV-Z]{26}$')) {
            throw "New report has invalid report_id: $newReportId"
        }
        Write-Host "[ok] new report: $newReportId at $newReportPath"

        # Step 4: Run prompt-fix via raw-byte capture (D81 prep).
        # The helper returns an object so the caller can enforce
        # per-path stderr semantics.
        $promptFix = Invoke-CliCaptureStdout `
            -CliArgs @('prompt-fix') `
            -ExpectedExit 0 `
            -StepName 'prompt-fix-render'
        $promptStdoutBytes = $promptFix.StdoutBytes

        # Success path: stderr MUST be empty. Locks against silent
        # warnings (e.g., a future deprecation notice) becoming
        # smoke-approved on the next run.
        if ($promptFix.StderrText -ne '') {
            throw "prompt-fix-render wrote unexpected stderr on success path:`n$($promptFix.StderrText)"
        }
        if ($promptStdoutBytes.Length -eq 0) {
            throw 'prompt-fix produced empty stdout despite exit 0'
        }

        # Step 5: Assert prompt-fix rendered the NEW report -- its
        # report_id MUST appear in the "Source report:" line. This
        # binds Phase 12d to the specific fresh report from Step 3,
        # closing the gap where default resolution could pick an
        # older report due to timestamp tie or resolver drift.
        $promptStdoutText = [System.Text.Encoding]::UTF8.GetString($promptStdoutBytes)
        $expectedSourceLine = "Source report: $newReportId"
        if (-not $promptStdoutText.Contains($expectedSourceLine)) {
            $previewLen = [Math]::Min(800, $promptStdoutText.Length)
            throw "prompt-fix did not render the NEW report. Expected '$expectedSourceLine' in stdout. First $previewLen chars of stdout:`n$($promptStdoutText.Substring(0, $previewLen))"
        }
        if (-not ($promptStdoutText -match '## Findings')) {
            throw 'prompt-fix stdout missing "## Findings" section header'
        }
        Write-Host "[ok] prompt-fix rendered the new report ($newReportId) with D85 structural markers"

        # Step 6: Compute expected sibling path beside the NEW
        # report. EXACTLY one fix-prompt.txt MUST exist (catches
        # accidental writes to both sessions/ and reports/), AND
        # it MUST be at that sibling path (D82 contract).
        $expectedSiblingPath = Join-Path (Split-Path -Parent $newReportPath) 'fix-prompt.txt'
        $persistedFiles = @(
            Get-ChildItem -Path '.viberevert/sessions/*/fix-prompt.txt', `
                                '.viberevert/reports/*/fix-prompt.txt' `
                -ErrorAction SilentlyContinue
        )
        if ($persistedFiles.Count -ne 1) {
            throw "Expected EXACTLY 1 persisted fix-prompt.txt, found $($persistedFiles.Count): $(($persistedFiles | ForEach-Object FullName) -join ', ')"
        }
        $persistedPath = $persistedFiles[0].FullName
        if ($persistedPath -ne $expectedSiblingPath) {
            throw "Persisted fix-prompt.txt is NOT the sibling of the new report. Expected: $expectedSiblingPath. Got: $persistedPath. D82 contract violation."
        }
        Write-Host "[ok] persisted fix-prompt.txt is sibling of the new report: $persistedPath"

        # Step 7: D81 dual-sink byte-identity. Read persisted file
        # as raw bytes; compare length + per-byte equality with
        # captured stdout. Manual loop because PowerShell 5.1 lacks
        # SequenceEqual on byte[] without Add-Type.
        $persistedBytes = [System.IO.File]::ReadAllBytes($persistedPath)
        if ($persistedBytes.Length -ne $promptStdoutBytes.Length) {
            throw "D81 byte-identity violation -- fix-prompt.txt length ($($persistedBytes.Length)) != stdout length ($($promptStdoutBytes.Length))"
        }
        for ($i = 0; $i -lt $persistedBytes.Length; $i++) {
            if ($persistedBytes[$i] -ne $promptStdoutBytes[$i]) {
                throw "D81 byte-identity violation at offset $($i): persisted=$($persistedBytes[$i]) stdout=$($promptStdoutBytes[$i])"
            }
        }
        Write-Host "[ok] D81 dual-sink byte-identity: $($persistedBytes.Length) bytes match"

        # Step 8: Snapshot file state BEFORE --llm test.
        $snapshotBytes = $persistedBytes
        $snapshotMtime = (Get-Item $persistedPath).LastWriteTimeUtc

        # Step 9: Run prompt-fix --llm. D84 reserved seam; exit 1
        # with the locked deferred-feature copy. Regular Invoke-Cli
        # (substring assertion handles the message; byte capture
        # unnecessary for refusal).
        Invoke-Cli -CliArgs @('prompt-fix', '--llm') `
            -ExpectedExit 1 `
            -StepName 'prompt-fix-llm-refused' `
            -ExpectedOutputContains 'Not available in v0.7.0'

        # Step 10: PRIMARY assertions on --llm refusal (all hard-
        # throw): exactly 1 fix-prompt.txt still exists, path
        # unchanged, bytes unchanged. SECONDARY (warn-only per D94
        # caveat): mtime unchanged.
        $afterLlmFiles = @(
            Get-ChildItem -Path '.viberevert/sessions/*/fix-prompt.txt', `
                                '.viberevert/reports/*/fix-prompt.txt' `
                -ErrorAction SilentlyContinue
        )
        if ($afterLlmFiles.Count -ne 1) {
            throw "After --llm refusal, expected exactly 1 fix-prompt.txt, found $($afterLlmFiles.Count) -- refusal must NOT create new sibling files"
        }
        if ($afterLlmFiles[0].FullName -ne $persistedPath) {
            throw "After --llm refusal, fix-prompt.txt path changed: was $persistedPath, now $($afterLlmFiles[0].FullName)"
        }
        $afterLlmBytes = [System.IO.File]::ReadAllBytes($persistedPath)
        if ($afterLlmBytes.Length -ne $snapshotBytes.Length) {
            throw "After --llm refusal, fix-prompt.txt size changed: was $($snapshotBytes.Length), now $($afterLlmBytes.Length)"
        }
        for ($i = 0; $i -lt $afterLlmBytes.Length; $i++) {
            if ($afterLlmBytes[$i] -ne $snapshotBytes[$i]) {
                throw "After --llm refusal, fix-prompt.txt byte mismatch at offset $($i)"
            }
        }
        Write-Host '[ok] --llm refusal left persisted fix-prompt.txt byte-identical at the same path (primary D84 lock)'

        $afterLlmMtime = (Get-Item $persistedPath).LastWriteTimeUtc
        if ($afterLlmMtime -ne $snapshotMtime) {
            # Secondary signal per D94 -- bytes proven identical
            # above, so this is informational platform noise on
            # filesystems with low mtime precision. Don't fail.
            Write-Host "[warn] LastWriteTimeUtc drifted after --llm refusal (was $snapshotMtime, now $afterLlmMtime); bytes still identical -- likely fs-precision platform noise per D94 caveat"
        } else {
            Write-Host '[ok] --llm refusal preserved LastWriteTimeUtc (secondary defense-in-depth signal)'
        }

        Write-Section 'M F 12e: hook install/uninstall (POSIX, --force backup, --restore round-trip)'

        # Step 1: Verify clean baseline -- no pre-existing pre-commit hook.
        $hookPath = Join-Path $scratch '.git/hooks/pre-commit'
        if (Test-Path $hookPath) {
            throw "Phase 12e precondition violated: .git/hooks/pre-commit already exists at $hookPath. Prior phase did not clean up."
        }

        # Step 2: Install. Exit 0 expected.
        Invoke-Cli -CliArgs @('hook', 'install') -ExpectedExit 0 -StepName 'hook-install-clean'

        # Step 3: Assert hook exists. Verify shebang + line-2 marker (D98.G).
        # Wrap Get-Content in @(...) to force-array -- PS scalar trap:
        # -TotalCount 2 returns a string (not array) when the file has 1
        # line, making $hookLines[1] index into the STRING.
        if (-not (Test-Path $hookPath)) {
            throw 'Phase 12e: hook install reported exit 0 but .git/hooks/pre-commit does NOT exist'
        }
        $hookLines = @(Get-Content -Path $hookPath -TotalCount 2)
        if ($hookLines.Count -lt 2) {
            throw "Phase 12e: hook has fewer than 2 lines. Line count: $($hookLines.Count)"
        }
        if ($hookLines[0] -ne '#!/bin/sh') {
            throw "Phase 12e: hook line 1 is not '#!/bin/sh'. Got: '$($hookLines[0])'"
        }
        $expectedMarker = '# managed-by: viberevert (https://github.com/madeinplutofabio/vibe-revert)'
        if ($hookLines[1] -ne $expectedMarker) {
            throw "Phase 12e: hook line 2 is not the managed-by marker. Expected: '$expectedMarker'. Got: '$($hookLines[1])'"
        }
        Write-Host '[ok] Phase 12e: hook line 1 = shebang, line 2 = managed-by marker (D98.G)'

        # Step 4: Verify body substrings + NO `set -e` (regression guard for
        # the plan-review bug: `set -e` would short-circuit before the EC=$?
        # capture and bypass the exit-2 -> exit-1 translation in D98.U).
        $hookContent = Get-Content -Path $hookPath -Raw
        $expectedSubstrings = @(
            'viberevert check --staged',
            '--no-verify',
            'viberevert prompt-fix'
        )
        foreach ($substr in $expectedSubstrings) {
            if (-not $hookContent.Contains($substr)) {
                throw "Phase 12e: hook body missing required substring: '$substr'"
            }
        }
        if ($hookContent.Contains('set -e')) {
            throw 'Phase 12e: hook body contains `set -e` (regression of plan-review bug)'
        }
        Write-Host '[ok] Phase 12e: hook body contains required substrings; no set -e (D98.U)'

        # Step 5: (POSIX only) Assert hook is executable. $IsWindows is
        # PSCore-only; $env:OS works in both Windows PS 5.1 AND PSCore.
        if ($env:OS -eq 'Windows_NT') {
            Write-Host '[skip] Phase 12e step 5 (executable bit): Windows -- chmod is a no-op per D98.J'
        } else {
            $mode = (Get-Item $hookPath).Mode
            if ($mode -notmatch 'x') {
                throw "Phase 12e step 5: hook is not executable. Mode: $mode"
            }
            Write-Host "[ok] Phase 12e step 5: hook is executable (mode: $mode)"
        }

        # Step 6: Block-commit verification with PATH shim + sh probe.
        # The hook script invokes `viberevert check --staged`; the sh
        # process spawned by git inherits PowerShell's PATH. Prepending
        # the local node_modules/.bin (where pnpm install put the
        # `viberevert` shim) ensures the hook resolves to the built CLI
        # WITHOUT relying on the developer's global PATH.
        #
        # sh probe distinguishes "platform cannot run hooks at all"
        # (legitimate skip per R1) from "hooks should run but didn't"
        # (real regression). Post-tip commitWasCreated check catches
        # the case where the hook prints the tip but the gate is broken.
        $shProbe = $null
        try {
            $shProbe = Start-Process sh -ArgumentList '-c', 'exit 0' -Wait -PassThru -NoNewWindow -ErrorAction SilentlyContinue
        } catch {
            # sh genuinely unavailable on this platform.
        }
        $platformCanRunHooks = ($shProbe -ne $null -and $shProbe.ExitCode -eq 0)

        & git add src/smoke-12d-trigger.py
        if ($LASTEXITCODE -ne 0) {
            throw "Phase 12e step 6: git add src/smoke-12d-trigger.py failed (exit $LASTEXITCODE)"
        }

        # Local-shim assertion: refuse to rely on the developer's global
        # PATH. Without this guard, a globally-installed `viberevert`
        # could falsely satisfy the hook on the dev box and fail CI.
        $sep = [System.IO.Path]::PathSeparator
        $binDir = Join-Path $scratch 'node_modules/.bin'
        if (-not (Test-Path $binDir)) {
            throw "Phase 12e step 6: local node_modules/.bin directory missing at $binDir"
        }
        $localViberevertShims = @(Get-ChildItem -Path $binDir -Filter 'viberevert*' -ErrorAction SilentlyContinue)
        if ($localViberevertShims.Count -eq 0) {
            throw "Phase 12e step 6: no local viberevert shim found in $binDir; refusing to rely on global PATH"
        }

        $originalPath = $env:PATH
        $env:PATH = "$binDir$sep$env:PATH"

        $commitStdoutFile = Join-Path $scratch 'phase-12e-commit-stdout.txt'
        $commitStderrFile = Join-Path $scratch 'phase-12e-commit-stderr.txt'

        # Initialize before try so the finally block can safely reference
        # them even if Start-Process / git rev-parse throw early.
        $headBefore = $null
        $commitWasCreated = $false

        try {
            # Pre-test cleanup of capture files (defense against stale
            # output if this phase is rerun after a partial failure).
            Remove-Item -Path $commitStdoutFile -ErrorAction SilentlyContinue
            Remove-Item -Path $commitStderrFile -ErrorAction SilentlyContinue

            $headBefore = & git rev-parse HEAD
            # Direct & git invocation (NOT Start-Process) -- PowerShell's
            # native-command argument passing preserves each arg verbatim
            # via the Win32 argv API; Start-Process collapses arrays into a
            # cmd-line string that the receiving program re-splits on
            # whitespace, causing pathspec-misparse when the commit message
            # contains spaces. Single-token message kept as belt-and-
            # suspenders defense in case this invocation is ever changed
            # back to Start-Process.
            #
            # Lower ErrorActionPreference to 'Continue' for the duration of
            # the call: the hook is EXPECTED to make git exit non-zero, and
            # Windows PowerShell with $ErrorActionPreference='Stop' promotes
            # a native command's non-zero exit + stderr output into a
            # NativeCommandError that can terminate the pipeline BEFORE we
            # can read $LASTEXITCODE. Even with `2> $file` redirection, PS
            # 5.1 can route stderr through its error stream during redirect,
            # so the Stop preference still fires. Mirrors the Invoke-Cli
            # helper pattern.
            $previousErrorActionPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & git commit -m phase-12e-hook-block-expected > $commitStdoutFile 2> $commitStderrFile
                $gitExit = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            $stdoutContent = if (Test-Path $commitStdoutFile) { Get-Content -Path $commitStdoutFile -Raw } else { '' }
            $stderrContent = if (Test-Path $commitStderrFile) { Get-Content -Path $commitStderrFile -Raw } else { '' }
            $combined = "$stdoutContent$stderrContent"
            $headAfter = & git rev-parse HEAD
            $commitWasCreated = ($headAfter -ne $headBefore)

            # D98.F + D98.U: hook exit-2 -> exit-1 translation prints this exact tip.
            # Single-quoted PowerShell string -- backticks are literal (no PS escape).
            $tip = 'Tip: run `viberevert prompt-fix` to generate a fix-prompt for your coding agent.'

            if ($combined.Contains($tip)) {
                if ($gitExit -ne 1) {
                    throw "Phase 12e step 6: hook printed tip but git exit was $gitExit, expected 1 (D98.F translation broken)"
                }
                if ($commitWasCreated) {
                    throw "Phase 12e step 6: hook printed tip but commit was created -- gate broken"
                }
                Write-Host '[ok] Phase 12e step 6: hook fired, blocked commit, printed prompt-fix tip (D98.F + D98.U)'
            } elseif (-not $platformCanRunHooks) {
                Write-Warning "Phase 12e step 6: sh probe failed; platform cannot execute git hooks. Treating as no-sh caveat per R1."
            } else {
                throw "Phase 12e step 6: sh probe succeeded so platform CAN run hooks, but the viberevert hook gate did NOT fire. git exit=$gitExit, tip present=$($combined.Contains($tip)), commit created=$commitWasCreated. Combined output:`n$combined"
            }
        } finally {
            $env:PATH = $originalPath
            # Centralized reset: if a commit was accidentally created
            # (no-sh caveat OR pre-throw race), undo it so the scratch
            # repo doesn't carry forward an advanced HEAD into later phases.
            if ($commitWasCreated -and $null -ne $headBefore) {
                & git reset --soft $headBefore | Out-Null
            }
            # Always unstage so the test file doesn't pollute later phases.
            & git reset -- src/smoke-12d-trigger.py | Out-Null
            Remove-Item -Path $commitStdoutFile -ErrorAction SilentlyContinue
            Remove-Item -Path $commitStderrFile -ErrorAction SilentlyContinue
        }

        # Step 7: Uninstall. Exit 0 expected.
        Invoke-Cli -CliArgs @('hook', 'uninstall') -ExpectedExit 0 -StepName 'hook-uninstall-managed'

        # Step 8: Assert hook is gone.
        if (Test-Path $hookPath) {
            throw 'Phase 12e step 8: hook uninstall reported exit 0 but .git/hooks/pre-commit still exists'
        }
        Write-Host '[ok] Phase 12e step 8: hook removed'

        # Step 9: Re-uninstall refuses with HookNotFoundError (D98.O).
        Invoke-Cli -CliArgs @('hook', 'uninstall') -ExpectedExit 1 -StepName 'hook-uninstall-no-hook-found' `
            -ExpectedOutputContains 'No viberevert hook found'

        # Step 10: --force backup + --restore round-trip sub-scenario (D98.D + D98.P).
        Write-Host '> Phase 12e step 10: --force backup + --restore round-trip'

        $sentinelContent = "#!/bin/sh`necho user-managed-sentinel`n"
        [System.IO.File]::WriteAllText($hookPath, $sentinelContent, (New-Object System.Text.UTF8Encoding($false)))
        $sentinelBytes = [System.IO.File]::ReadAllBytes($hookPath)

        # 10a. Install without --force refuses (existing non-vr hook per D98.D).
        Invoke-Cli -CliArgs @('hook', 'install') -ExpectedExit 1 -StepName 'hook-install-refuses-without-force' `
            -ExpectedOutputContains 'Refusing to overwrite existing non-viberevert pre-commit hook'

        # Sentinel must be byte-for-byte untouched after refusal (D98
        # no-mutation-on-refusal contract). Byte loop matches 10c/10e
        # discipline -- length-only would miss same-size content mutation.
        $sentinelAfterRefusal = [System.IO.File]::ReadAllBytes($hookPath)
        if ($sentinelAfterRefusal.Length -ne $sentinelBytes.Length) {
            throw "Phase 12e step 10a: sentinel size changed after refused install (was $($sentinelBytes.Length), now $($sentinelAfterRefusal.Length))"
        }
        for ($i = 0; $i -lt $sentinelBytes.Length; $i++) {
            if ($sentinelAfterRefusal[$i] -ne $sentinelBytes[$i]) {
                throw "Phase 12e step 10a: sentinel byte mismatch at offset $i after refused install"
            }
        }

        # 10b. Install --force backs up + writes new hook (D98.D).
        Invoke-Cli -CliArgs @('hook', 'install', '--force') -ExpectedExit 0 -StepName 'hook-install-force-backup'

        # 10c. Assert backup exists at locked BACKUP_FILE_REGEX pattern.
        $hooksDir = Join-Path $scratch '.git/hooks'
        $backups = @(Get-ChildItem -Path $hooksDir -Filter 'pre-commit.viberevert-backup-*' -ErrorAction SilentlyContinue)
        if ($backups.Count -ne 1) {
            throw "Phase 12e step 10c: expected exactly 1 backup file, found $($backups.Count): $(($backups | ForEach-Object Name) -join ', ')"
        }
        $backupPath = $backups[0].FullName
        if ($backups[0].Name -notmatch '^pre-commit\.viberevert-backup-\d{8}T\d{6}Z$') {
            throw "Phase 12e step 10c: backup name '$($backups[0].Name)' does not match locked BACKUP_FILE_REGEX (^pre-commit\.viberevert-backup-\d{8}T\d{6}Z$)"
        }
        # Backup content byte-identical to sentinel.
        $backupBytes = [System.IO.File]::ReadAllBytes($backupPath)
        if ($backupBytes.Length -ne $sentinelBytes.Length) {
            throw "Phase 12e step 10c: backup size ($($backupBytes.Length)) != sentinel size ($($sentinelBytes.Length))"
        }
        for ($i = 0; $i -lt $sentinelBytes.Length; $i++) {
            if ($backupBytes[$i] -ne $sentinelBytes[$i]) {
                throw "Phase 12e step 10c: backup byte mismatch at offset $i (backup=$($backupBytes[$i]) sentinel=$($sentinelBytes[$i]))"
            }
        }
        Write-Host "[ok] Phase 12e step 10c: backup at $($backups[0].Name) byte-identical to sentinel ($($backupBytes.Length) bytes)"

        # 10d. uninstall --restore renames backup back over the managed hook (D98.P).
        Invoke-Cli -CliArgs @('hook', 'uninstall', '--restore') -ExpectedExit 0 -StepName 'hook-uninstall-restore'

        # 10e. pre-commit matches sentinel byte-for-byte; backup gone (rename source).
        $restoredBytes = [System.IO.File]::ReadAllBytes($hookPath)
        if ($restoredBytes.Length -ne $sentinelBytes.Length) {
            throw "Phase 12e step 10e: restored size ($($restoredBytes.Length)) != sentinel size ($($sentinelBytes.Length))"
        }
        for ($i = 0; $i -lt $sentinelBytes.Length; $i++) {
            if ($restoredBytes[$i] -ne $sentinelBytes[$i]) {
                throw "Phase 12e step 10e: restored byte mismatch at offset $i"
            }
        }
        if (Test-Path $backupPath) {
            throw "Phase 12e step 10e: backup file still present after --restore at $backupPath (rename should have consumed it)"
        }
        Write-Host "[ok] Phase 12e step 10e: --restore round-trip byte-identical; backup consumed by rename"

        # Step 10 cleanup: remove the restored sentinel hook so Phase 12b-last
        # operates against a clean .git/hooks/ state.
        Remove-Item -Path $hookPath -Force
        if (Test-Path $hookPath) {
            throw 'Phase 12e cleanup: failed to remove sentinel hook before Phase 12b-last'
        }
        Write-Host '[ok] Phase 12e cleanup: sentinel removed'

        Write-Section 'M G1a 12f: MCP server stdio probe (BOTH reserved names; R31 audit sentinel; D99.R locked single-shot)'

        # === Local helpers (scoped to Phase 12f) ===

        # Select-SingleAuditRecord: select exactly one audit record matching
        # a predicate. Throws on count !== 1 with a diagnostic dump of all
        # records. Used to select by record SHAPE rather than array index --
        # JSON-RPC dispatch (R27) and audit-write completion are async, so
        # audit-line order is NOT guaranteed to match request-input order.
        function Select-SingleAuditRecord {
            param(
                [Parameter(Mandatory)][object[]]$Records,
                [Parameter(Mandatory)][scriptblock]$Predicate,
                [Parameter(Mandatory)][string]$Label
            )
            $matches = @($Records | Where-Object $Predicate)
            if ($matches.Count -ne 1) {
                throw "Phase 12f audit: expected exactly one '${Label}' record, got $($matches.Count). All records:`n$($Records | ConvertTo-Json -Depth 10)"
            }
            return $matches[0]
        }

        # Assert-Cat2Shape: lock the full Cat 2 wire shape per D99.O + R31:
        #   result.isError === true
        #   result.content.Count === 1
        #   result.content[0].type === 'text'
        #   result.content[0].text === <exact locked string> (R31 generic; tool name NOT echoed)
        #   result.structuredContent === $null  (D99.O: Cat 2 carries no typed payload)
        # The text uses EXACT equality (not regex) so whitespace / casing
        # regressions surface as failures.
        $expectedDeniedText = 'MCP error -32602: Tool not found'
        function Assert-Cat2Shape {
            param(
                [Parameter(Mandatory)][object]$Resp,
                [Parameter(Mandatory)][string]$IdLabel,
                [Parameter(Mandatory)][string]$ProbeName,
                [Parameter(Mandatory)][string]$ExpectedText
            )
            if (-not $Resp.result.isError) {
                throw "Phase 12f id=${IdLabel} ${ProbeName}: expected result.isError=true (Cat 2 per D99.O)"
            }
            # @() wrap defends against PS 5.1's ConvertFrom-Json quirk where
            # a single-element JSON array can unwrap to a bare object.
            $content = @($Resp.result.content)
            if ($content.Count -ne 1) {
                throw "Phase 12f id=${IdLabel} ${ProbeName}: expected result.content to have exactly 1 entry, got $($content.Count) (D99.O Cat 2 shape lock)"
            }
            if ($content[0].type -ne 'text') {
                throw "Phase 12f id=${IdLabel} ${ProbeName}: expected result.content[0].type='text', got '$($content[0].type)' (D99.O Cat 2 shape lock)"
            }
            if ($content[0].text -ne $ExpectedText) {
                throw "Phase 12f id=${IdLabel} ${ProbeName}: text expected exactly '${ExpectedText}' (R31 generic message; tool name MUST NOT be echoed), got '$($content[0].text)'"
            }
            if ($null -ne $Resp.result.structuredContent) {
                throw "Phase 12f id=${IdLabel} ${ProbeName}: Cat 2 MUST NOT have structuredContent (D99.O), got: $($Resp.result.structuredContent | ConvertTo-Json -Compress -Depth 10)"
            }
        }

        # === Setup ===
        # Temp files for input, stdout, stderr. File-redirection (not PS
        # variable capture) for both output channels: bytes-clean (no PS
        # variable encoding quirks on large output) AND separates stderr
        # from stdout so D99.M.14 "mcp library never writes stderr" becomes
        # a positive smoke assertion (success path -> empty stderr).
        $mcpInputFile = Join-Path $scratch 'mcp-probe-input.ndjson'
        $mcpOutputFile = Join-Path $scratch 'mcp-probe-output.ndjson'
        $mcpStderrFile = Join-Path $scratch 'mcp-probe-stderr.txt'
        $mcpAuditPath = Join-Path $scratch '.viberevert/mcp-audit.log'

        # Defensive: clear any prior artifacts so we observe ONLY this
        # probe's records. No prior smoke phase populates these paths,
        # but a re-run with -KeepArtifacts could leave them behind.
        foreach ($p in @($mcpInputFile, $mcpOutputFile, $mcpStderrFile, $mcpAuditPath)) {
            if (Test-Path $p) { Remove-Item -Force $p }
        }

        # 7 input frames: 6 requests + 1 notification per MCP protocol.
        # `notifications/initialized` (sent by real clients after the
        # initialize response) has NO id field per JSON-RPC, so it
        # produces NO response. Response count therefore stays at 6 even
        # though we write 7 input frames. The stdio-server unit test
        # sends this same sequence; smoke mirrors it for protocol
        # conformance.
        $mcpRequests = @(
            '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-12f","version":"0.0.0"}}}',
            '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
            '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
            '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_policy","arguments":{}}}',
            '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rollback","arguments":{}}}',
            '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"request_human_approval","arguments":{}}}',
            '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"made_up_tool","arguments":{}}}'
        )
        # Newline-delimited JSON-RPC framing per D99.D (NOT LSP Content-
        # Length headers). LF-only (no CRLF). Send-McpFrame appends the LF
        # terminator per call; the $mcpInputBody assembly here is purely
        # a diagnostic snapshot persisted to $mcpInputFile so a failure
        # can be reproduced post-mortem by re-feeding the same bytes.
        $mcpInputBody = ($mcpRequests -join "`n") + "`n"
        # UTF-8 NO BOM. Server expects pure UTF-8; a BOM at byte 0 would
        # corrupt the first request's JSON parse. The same encoder is
        # passed into Send-McpFrame / Wait-McpResponseById / Get-McpAuditDump
        # so all byte<->string boundaries use one explicit encoding.
        $utf8NoBomMcp = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($mcpInputFile, $mcpInputBody, $utf8NoBomMcp)

        # Drift guard: $mcpRequests + interactive transcript below are
        # paired by frame index. If a future change adds/removes frames,
        # this assertion catches the mismatch before the harness runs.
        if ($mcpRequests.Count -ne 7) {
            throw "Phase 12f: internal error -- expected 7 frames in `$mcpRequests, got $($mcpRequests.Count). The interactive transcript below assumes exactly 7 frames in the documented order."
        }

        # === Probe ===
        # Node-side MCP stdio probe owns the transport contract.
        # PowerShell orchestrates + parses; Node writes UTF-8 bytes
        # to the MCP child. See scripts/mcp-stdio-probe.mjs for the
        # architecture rationale: removing PowerShell/.NET from the
        # stdio path eliminates the proven BOM-preamble failure class
        # (PS 5.1's Process.StandardInput auto-StreamWriter was
        # injecting EF BB BF before the first JSON-RPC frame on GHA
        # windows-latest, causing SDK JSON.parse to reject initialize
        # with SyntaxError). PowerShell still owns:
        #   - $mcpRequests source of truth (already written to
        #     $mcpInputFile above via UTF8Encoding($false))
        #   - all 18+ downstream invariant assertions (8-tool order,
        #     reserved-name hiding, Cat 2 denial shapes, audit field
        #     order, R31 reflection locks, etc.)
        # Node owns:
        #   - spawning the MCP child as direct node.exe
        #   - writing UTF-8 Buffer frames to child.stdin
        #   - reading line-delimited JSON responses from child.stdout
        #   - enforcing close code 0 + empty stderr
        Write-Host '> node scripts/mcp-stdio-probe.mjs (PowerShell orchestrates; Node owns MCP stdio transport)'

        # Defensive double-guard on the proven root cause. The Node
        # probe also enforces BOM-absence on its end, but locking it
        # here means a regression in the upstream writer fails fast
        # at the PowerShell boundary with clear locality.
        $mcpInputBytes = [System.IO.File]::ReadAllBytes($mcpInputFile)
        if ($mcpInputBytes.Length -ge 3 -and $mcpInputBytes[0] -eq 0xEF -and $mcpInputBytes[1] -eq 0xBB -and $mcpInputBytes[2] -eq 0xBF) {
            throw "Phase 12f: ${mcpInputFile} unexpectedly starts with UTF-8 BOM (EF BB BF). PowerShell side must use UTF8Encoding(`$false) for this file."
        }

        $probeScript = Join-Path $repoRoot 'scripts/mcp-stdio-probe.mjs'
        $viberevertEntry = Join-Path (Get-Location).Path 'node_modules/viberevert/dist/index.js'

        if (-not (Test-Path $viberevertEntry)) {
            throw "Phase 12f: expected installed viberevert entrypoint missing: $viberevertEntry"
        }
        if (-not (Test-Path $probeScript)) {
            throw "Phase 12f: expected probe script missing: $probeScript"
        }

        $probeOutput = & node $probeScript `
            --cwd (Get-Location).Path `
            --entry $viberevertEntry `
            --input $mcpInputFile `
            --output $mcpOutputFile `
            --stderr $mcpStderrFile `
            --audit $mcpAuditPath 2>&1
        $probeExitCode = $LASTEXITCODE

        if ($probeExitCode -ne 0) {
            throw "Phase 12f probe exit ${probeExitCode}:`n$($probeOutput -join "`n")"
        }

        # Silent-on-success contract: probe writes only to files +
        # stderr on failure. Any nonblank output here is a regression.
        $probeOutputLines = @($probeOutput | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($probeOutputLines.Count -gt 0) {
            throw "Phase 12f: probe exit 0 but emitted unexpected output (probe must be silent on success):`n$($probeOutputLines -join "`n")"
        }

        # Read mcp-output.jsonl into $mcpResponses (id -> parsed object).
        # Duplicate-id detection is enforced both in the probe and
        # here -- defense in depth on the wire-shape invariant.
        if (-not (Test-Path $mcpOutputFile)) {
            throw "Phase 12f: expected $mcpOutputFile to exist after probe"
        }
        $responseLines = @(Get-Content -Path $mcpOutputFile -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($responseLines.Count -ne 6) {
            throw "Phase 12f: expected 6 response lines in ${mcpOutputFile}, got $($responseLines.Count). Lines:`n$($responseLines -join "`n")"
        }

        $mcpResponses = @{}
        foreach ($line in $responseLines) {
            $parsed = $line | ConvertFrom-Json
            $idInt = [int]$parsed.id
            if ($mcpResponses.ContainsKey($idInt)) {
                throw "Phase 12f: duplicate JSON-RPC response id=${idInt} in ${mcpOutputFile}"
            }
            $mcpResponses[$idInt] = $parsed
        }

        $expectedIds = @(1, 2, 3, 4, 5, 6)
        foreach ($id in $expectedIds) {
            if (-not $mcpResponses.ContainsKey($id)) {
                throw "Phase 12f: missing JSON-RPC response id=$id after Node probe. Got ids: $($mcpResponses.Keys -join ',')"
            }
        }
        Write-Host '[ok] Phase 12f: MCP server stdio transcript validated via Node probe; 6 responses captured (ids 1..6)'

        # === All 6 responses must be JSON-RPC SUCCESS envelopes (no top-level `error`) ===
        # Cat 2 denials use result.isError=true on a JSON-RPC SUCCESS
        # envelope per D99.O, NOT a JSON-RPC error envelope (-32602/-32603
        # in the top-level error field). The top-level `error` field is
        # reserved for Cat 4 (server-integrity throws via McpError). A
        # regression that converted Cat 2 -> Cat 4 would silently break
        # SDK client compatibility; this assertion is the wall.
        foreach ($id in $expectedIds) {
            if ($null -ne $mcpResponses[$id].error) {
                throw "Phase 12f id=${id}: expected JSON-RPC success envelope (no top-level 'error' field per D99.O -- Cat 2 denials use result.isError=true on success envelope, NOT JSON-RPC error envelope; top-level error is reserved for Cat 4 integrity throws). Got error: $($mcpResponses[$id].error | ConvertTo-Json -Compress -Depth 10)"
            }
        }
        Write-Host '[ok] Phase 12f: all 6 responses are JSON-RPC success envelopes (no top-level error; Cat 2 vs Cat 4 distinction preserved per D99.O)'

        # === id=1 initialize: protocolVersion locked at "2025-06-18" (D99.Y) ===
        $initResp = $mcpResponses[1]
        if ($initResp.result.protocolVersion -ne '2025-06-18') {
            throw "Phase 12f id=1 initialize: expected protocolVersion='2025-06-18' (D99.Y), got '$($initResp.result.protocolVersion)'"
        }
        Write-Host '[ok] Phase 12f id=1 initialize: protocolVersion=2025-06-18 (D99.Y locked)'

        # === id=2 tools/list: 8 tools in D99.A order; both reserved names absent (D99.B) ===
        $listResp = $mcpResponses[2]
        $expectedTools = @(
            'check_repo','explain_diff','classify_risk','list_risky_files','get_policy',
            'start_session','create_checkpoint','generate_fix_prompt'
        )
        $actualTools = @($listResp.result.tools | ForEach-Object { $_.name })
        if ($actualTools.Count -ne 8) {
            throw "Phase 12f id=2 tools/list: expected 8 tools, got $($actualTools.Count): $($actualTools -join ',')"
        }
        for ($i = 0; $i -lt 8; $i++) {
            if ($actualTools[$i] -ne $expectedTools[$i]) {
                throw "Phase 12f id=2 tools/list: tool[$i] expected '$($expectedTools[$i])', got '$($actualTools[$i])' (D99.A order lock)"
            }
        }
        foreach ($r in @('rollback', 'request_human_approval')) {
            if ($actualTools -contains $r) {
                throw "Phase 12f id=2 tools/list: reserved name '$r' MUST NOT appear in tools/list (D99.B)"
            }
        }
        Write-Host '[ok] Phase 12f id=2 tools/list: 8 tools in D99.A order; both reserved names absent (D99.B)'

        # === id=3 tools/call get_policy: Cat 1 success per D99.O ===
        $getPolicyResp = $mcpResponses[3]
        if ($getPolicyResp.result.isError) {
            throw "Phase 12f id=3 get_policy: expected isError absent/false (Cat 1 success), got isError=$($getPolicyResp.result.isError). Response: $($getPolicyResp | ConvertTo-Json -Compress -Depth 10)"
        }
        if (-not $getPolicyResp.result.structuredContent.ok) {
            throw "Phase 12f id=3 get_policy: expected structuredContent.ok=true, got: $($getPolicyResp.result.structuredContent | ConvertTo-Json -Compress -Depth 10)"
        }
        if ($null -eq $getPolicyResp.result.structuredContent.data.risk.block_on) {
            throw "Phase 12f id=3 get_policy: expected data.risk.block_on present (loaded from .viberevert.yml), got: $($getPolicyResp.result.structuredContent.data | ConvertTo-Json -Compress -Depth 10)"
        }
        Write-Host '[ok] Phase 12f id=3 get_policy: Cat 1 success; structuredContent.ok=true; data.risk.block_on present'

        # === id=4..6 tools/call denials: Cat 2 shape per D99.O + R31 ===
        # All three denials must have IDENTICAL Cat 2 wire shape (no leak
        # distinguishing reserved from unknown per D99.B). Assert-Cat2Shape
        # locks the full shape per call.
        Assert-Cat2Shape -Resp $mcpResponses[4] -IdLabel '4' -ProbeName 'rollback' -ExpectedText $expectedDeniedText
        Write-Host '[ok] Phase 12f id=4 rollback: Cat 2 reserved-denial wire shape locked (D99.O + R31)'
        Assert-Cat2Shape -Resp $mcpResponses[5] -IdLabel '5' -ProbeName 'request_human_approval' -ExpectedText $expectedDeniedText
        Write-Host '[ok] Phase 12f id=5 request_human_approval: Cat 2 reserved-denial wire shape locked (D99.R BOTH reserved names probed)'
        Assert-Cat2Shape -Resp $mcpResponses[6] -IdLabel '6' -ProbeName 'made_up_tool' -ExpectedText $expectedDeniedText
        Write-Host '[ok] Phase 12f id=6 made_up_tool: Cat 2 unknown-denial wire shape IDENTICAL to reserved (no leak per D99.B)'

        # === R31 raw-name absence in id=6 response (full-JSON substring scan) ===
        # The raw unknown name "made_up_tool" MUST NOT appear ANYWHERE in
        # the id=6 response JSON (not in text, not in any nested field).
        # R31 contract: arbitrary unknown names are NEVER reflected.
        $id6Json = ($mcpResponses[6] | ConvertTo-Json -Compress -Depth 10)
        if ($id6Json.Contains('made_up_tool')) {
            throw "Phase 12f id=6 made_up_tool: raw unknown name leaked into response JSON (R31 violation -- arbitrary unknown names MUST NOT be reflected in any response field). Response: $id6Json"
        }
        Write-Host '[ok] Phase 12f id=6: raw unknown name made_up_tool NOT in response JSON (R31 reflection lock)'

        # === Audit log: 4 NDJSON records per D99.J locked shapes + R31 sentinel ===
        # Selected BY SHAPE (not array index) because JSON-RPC dispatch is
        # async (R27) and audit-write completion order may differ from
        # request input order, especially since get_policy (real loadConfig
        # IO) may complete after the Cat 2 string-compare denials.
        if (-not (Test-Path $mcpAuditPath)) {
            throw "Phase 12f audit: expected $mcpAuditPath to exist after MCP serve invocation"
        }
        $auditLines = @(Get-Content -Path $mcpAuditPath -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($auditLines.Count -ne 4) {
            throw "Phase 12f audit: expected exactly 4 NDJSON records, got $($auditLines.Count). Records:`n$($auditLines -join `"`n---`n`")"
        }
        $auditRecords = @($auditLines | ForEach-Object { $_ | ConvertFrom-Json })

        # Select each record by SHAPE via predicate (event + tool_name + reserved)
        $r1 = Select-SingleAuditRecord -Records $auditRecords -Label 'tool_call ok:true get_policy' `
            -Predicate { $_.event -eq 'tool_call' -and $_.tool_name -eq 'get_policy' }
        $r2 = Select-SingleAuditRecord -Records $auditRecords -Label 'tool_call_denied rollback (reserved)' `
            -Predicate { $_.event -eq 'tool_call_denied' -and $_.tool_name -eq 'rollback' }
        $r3 = Select-SingleAuditRecord -Records $auditRecords -Label 'tool_call_denied request_human_approval (reserved)' `
            -Predicate { $_.event -eq 'tool_call_denied' -and $_.tool_name -eq 'request_human_approval' }
        $r4 = Select-SingleAuditRecord -Records $auditRecords -Label 'tool_call_denied <unknown> (R31 sentinel)' `
            -Predicate { $_.event -eq 'tool_call_denied' -and $_.tool_name -eq '<unknown>' -and $_.reserved -eq $false }

        # ----- $r1 field-order + value assertions -----
        # Locked field order (verified against packages/mcp/src/audit.ts
        # L237): schema_version, event, ts, tool_name, ok, exit_code,
        # duration_ms. schema_version is the writer-injected header
        # field FIRST in every record.
        $expectedR1Keys = @('schema_version','event','ts','tool_name','ok','exit_code','duration_ms')
        $r1Keys = @($r1.PSObject.Properties.Name)
        if (($r1Keys -join ',') -ne ($expectedR1Keys -join ',')) {
            throw "Phase 12f audit r1 (get_policy): field order expected '$($expectedR1Keys -join ',')', got '$($r1Keys -join ',')' (D99.J locked field order)"
        }
        if ($r1.ok -ne $true) { throw "Phase 12f audit r1 (get_policy): ok expected true, got '$($r1.ok)'" }
        if ($r1.exit_code -ne 0) { throw "Phase 12f audit r1 (get_policy): exit_code expected 0, got '$($r1.exit_code)'" }
        Write-Host '[ok] Phase 12f audit r1 (get_policy): tool_call ok:true exit:0 (D99.J field order locked)'

        # ----- $r2 + $r3 field-order + value assertions (reserved-denied shape) -----
        # Locked field order (verified against packages/mcp/src/audit.ts
        # L267): schema_version, event, ts, tool_name, ok, error_code,
        # reserved, exposed, reason. R31: reserved names ARE in
        # RESERVED_TOOL_NAMES -- audit echoes the sanitized name
        # verbatim (already verified by Select predicate).
        $expectedReservedKeys = @('schema_version','event','ts','tool_name','ok','error_code','reserved','exposed','reason')
        foreach ($pair in @(@{rec=$r2; label='rollback'}, @{rec=$r3; label='request_human_approval'})) {
            $rec = $pair.rec
            $recKeys = @($rec.PSObject.Properties.Name)
            if (($recKeys -join ',') -ne ($expectedReservedKeys -join ',')) {
                throw "Phase 12f audit ($($pair.label)): field order expected '$($expectedReservedKeys -join ',')', got '$($recKeys -join ',')' (D99.J locked field order)"
            }
            if ($rec.ok -ne $false) { throw "Phase 12f audit ($($pair.label)): ok expected false, got '$($rec.ok)'" }
            if ($rec.error_code -ne 'TOOL_NOT_FOUND') { throw "Phase 12f audit ($($pair.label)): error_code expected 'TOOL_NOT_FOUND', got '$($rec.error_code)'" }
            if ($rec.reserved -ne $true) { throw "Phase 12f audit ($($pair.label)): reserved expected true, got '$($rec.reserved)'" }
            if ($rec.exposed -ne $false) { throw "Phase 12f audit ($($pair.label)): exposed expected false, got '$($rec.exposed)'" }
            if ($rec.reason -ne 'reserved_approval_gated_not_exposed') { throw "Phase 12f audit ($($pair.label)): reason expected 'reserved_approval_gated_not_exposed', got '$($rec.reason)'" }
        }
        Write-Host '[ok] Phase 12f audit r2 (rollback) + r3 (request_human_approval): tool_call_denied reserved:true reason locked (D99.J field order; R31 verbatim echo)'

        # ----- $r4 field-order + value assertions (unknown-denied shape; R31 sentinel) -----
        # Locked field order (verified against packages/mcp/src/audit.ts):
        # schema_version, event, ts, tool_name, ok, error_code, reserved,
        # exposed (NO 'reason' for unknown-denied). R31 SENTINEL:
        # tool_name="<unknown>" (already verified by Select predicate);
        # arbitrary unknown names MUST NOT be echoed in audit.
        $expectedUnknownKeys = @('schema_version','event','ts','tool_name','ok','error_code','reserved','exposed')
        $r4Keys = @($r4.PSObject.Properties.Name)
        if (($r4Keys -join ',') -ne ($expectedUnknownKeys -join ',')) {
            throw "Phase 12f audit r4 (<unknown>): field order expected '$($expectedUnknownKeys -join ',')', got '$($r4Keys -join ',')' (D99.J unknown-denied has NO 'reason' field)"
        }
        if ($r4.PSObject.Properties.Name -contains 'reason') {
            throw "Phase 12f audit r4 (<unknown>): 'reason' field MUST be absent for unknown-denial (D99.J)"
        }
        Write-Host '[ok] Phase 12f audit r4 (<unknown>): tool_call_denied reserved:false NO reason (R31 sentinel via Select predicate)'

        # === Cross-record audit invariants ===
        $auditFullText = ($auditLines -join "`n")
        # 1. No raw arguments anywhere (D99.J -- never log args).
        foreach ($tok in @('"input"', '"args"', '"arguments"')) {
            if ($auditFullText.Contains($tok)) {
                throw "Phase 12f audit: forbidden token '$tok' found in audit log (D99.J -- raw arguments MUST NEVER be logged). Full audit:`n$auditFullText"
            }
        }
        Write-Host '[ok] Phase 12f audit cross-record: NO input/args/arguments tokens (D99.J never-log-args)'

        # 2. R31 sentinel substitution verified at byte level: raw unknown
        # name 'made_up_tool' MUST NOT appear anywhere in the audit log
        # (sentinel '<unknown>' replaces it at write time).
        if ($auditFullText.Contains('made_up_tool')) {
            throw "Phase 12f audit cross-record: raw unknown name 'made_up_tool' leaked into audit log (R31 violation -- sentinel '<unknown>' MUST replace arbitrary unknown names). Full audit:`n$auditFullText"
        }
        Write-Host '[ok] Phase 12f audit cross-record: raw unknown name made_up_tool NOT in audit (R31 sentinel substitution verified at byte level)'

        Write-Host '[ok] Phase 12f: ALL probes + audit assertions green (6 JSON-RPC responses + 4 audit records; BOTH reserved names probed; R31 sentinel + reflection locks; no leak between reserved/unknown response or audit shapes; empty stderr per D99.M.14)'

        # === Cleanup: remove all 4 Phase 12f temp files before Phase 12b-last ===
        # Phase 12b-last operates on a clean state. We do NOT remove
        # .viberevert/ because earlier phases populated it (e.g., 12c
        # session artifacts).
        foreach ($p in @($mcpInputFile, $mcpOutputFile, $mcpStderrFile, $mcpAuditPath)) {
            Remove-Item -Force $p -ErrorAction SilentlyContinue
        }

        Write-Section 'M C 12b: missing config (LAST scenario - corrupts state for any later steps)'
        Remove-Item -Force '.viberevert.yml'
        if (Test-Path '.viberevert.yml') {
            throw '.viberevert.yml deletion failed; required precondition for missing-config check'
        }
        Invoke-Cli -CliArgs @('check', '--since', 'dirty-base') -ExpectedExit 1 -StepName 'check-missing-config-refused'

    } finally {
        Pop-Location
    }

    Write-Section 'Summary'
    Write-Host "CLI steps passed: $passCount"
    Write-Host "CLI steps failed: $failCount"
    Write-Host '[ALL PASS] M B + M C + M D Phase 12a + 12b + 12c smoke test green.'

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
