# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Fabio Marcello Salvadori

# VibeRevert M B + M C + M D smoke test (Phase 12a + 12b + 12c).
# Builds + packs the 6 currently publishable packages, installs them into a
# scratch dir under $env:TEMP, and exercises the M B command surface AND the
# M C/D Phase 12a + 12b + 12c packed-install scenarios (basic check + report
# flows, targeted package-boundary proofs, and the M D rollback dry-run +
# apply + idempotency flow) against a real `git init` repo.
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
    #      pipeline mid-call, BEFORE we can check $LASTEXITCODE — and every
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

    # 2. Pack the 6 publishable packages into $packDir.
    Write-Section "Pack publishable packages into $packDir"
    New-Item -ItemType Directory -Force $packDir | Out-Null
    Push-Location $repoRoot
    try {
        & pnpm --filter '@viberevert/session-format' `
               --filter '@viberevert/core' `
               --filter '@viberevert/git' `
               --filter '@viberevert/checks' `
               --filter '@viberevert/reporters' `
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
    # `viberevert-<version>.tgz` — match digit-leading suffix so we don't pick
    # up viberevert-git/core/session-format/checks/reporters tarballs (which also
    # start with `viberevert-`).
    # Note: PowerShell/Windows `-Filter` is filesystem-provider filtering, NOT a bash-style
    # glob — character classes like `[0-9]` do NOT work. Use a `Where-Object` regex (.NET regex)
    # via `-match` instead. Sort-Object for deterministic selection if multiple matches ever exist.
    $tgzCl = (Get-ChildItem $packDir -Filter 'viberevert-*.tgz' |
        Where-Object { $_.Name -match '^viberevert-\d' } |
        Sort-Object Name |
        Select-Object -First 1).FullName

    foreach ($tgz in @($tgzSf, $tgzCo, $tgzGi, $tgzCh, $tgzRe, $tgzCl)) {
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
        $pCh = $tgzCh -replace '\\', '/'
        $pRe = $tgzRe -replace '\\', '/'
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
      "@viberevert/reporters": "file:$pRe"
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
        # render — the report's findings do NOT affect this command's exit
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
        # restore semantic — untracked-only deletion is insufficient
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
        # semantic — proves restore actually works on tracked files).
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
