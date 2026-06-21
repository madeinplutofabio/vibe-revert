# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Fabio Marcello Salvadori

# scripts/post-publish-smoke.ps1 -- Step 5 acceptance gate (A6, A13).
#
# Validates the npm-published viberevert@beta tarballs by:
#   1. Installing into a fresh scratch dir via `npm install viberevert@beta`
#      with retry/backoff that checks BOTH install success AND that the
#      installed version matches -ExpectedVersion -- catches stale CDN
#      dist-tag pointing at older beta even when the install itself
#      succeeds
#   2. Asserting npx viberevert --version output contains -ExpectedVersion
#   3. Running npx viberevert doctor + npx viberevert init --profile generic
#   4. Running the FULL 7-frame Phase 12f MCP stdio transcript via
#      scripts/mcp-stdio-probe.mjs against the npm-installed viberevert,
#      proving the same MCP wire-shape + audit locks against published
#      bytes that smoke-test.ps1's release-dry-run job proves against
#      locally-packed bytes:
#        initialize, notifications/initialized, tools/list,
#        get_policy, rollback denial, request_human_approval denial,
#        made_up_tool denial
#      => 6 responses + 4 audit records (1 tool_call ok + 3 denials)
#   5. Asserting the locked 8-tool order from D99.A (not just count)
#   6. Asserting Cat 2 wire shape on the 3 denial responses (D99.O + R31)
#   7. Asserting the 4 audit records' shape (1 tool_call + 3 tool_call_denied)
#
# Invocation modes:
#   - Manually after the tag push:
#       powershell.exe -ExecutionPolicy Bypass -File scripts/post-publish-smoke.ps1 -ExpectedVersion 0.7.0-beta.0
#   - From .github/workflows/release.yml after all 8 publishes succeed
#     and BEFORE GitHub Release creation. If this fails post-publish,
#     do NOT reuse the tag/version per the partial-publish policy --
#     bump to the next beta iteration and retry.
#
# Args:
#   -ExpectedVersion <string>   required; the version we expect to
#                               install (e.g., "0.7.0-beta.0")
#   -KeepArtifacts              do not clean up scratch dir even on
#                               success (debugging aid). On failure
#                               the scratch is ALWAYS preserved.
#
# Exit codes:
#   0 -- all assertions pass; published viberevert@beta is healthy
#   1 -- any failure (install/version retry exhausted, doctor/init
#         failure, MCP probe failure, response/audit assertion
#         failure). Scratch preserved for diagnostics.

param(
    [Parameter(Mandatory)][string]$ExpectedVersion,
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'

# --- State -----------------------------------------------------------------

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$probeScript = Join-Path $repoRoot 'scripts/mcp-stdio-probe.mjs'
$timestamp = Get-Date -Format 'yyyyMMddHHmmss'
$suffix = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
$runId = "$timestamp-$suffix"
# .NET Path.GetTempPath() resolves the OS-appropriate temp dir on
# Windows, Linux, and macOS without relying on the $env:TEMP shell
# variable (which may be absent under GHA Linux pwsh or other
# non-Windows shells). Trailing separator is handled by Join-Path.
$tempRoot = [System.IO.Path]::GetTempPath()
$scratch = Join-Path $tempRoot "viberevert-postpublish-$runId"
$succeeded = $false

# UTF-8 no-BOM encoder (same discipline as smoke-test.ps1).
$utf8NoBomMcp = [System.Text.UTF8Encoding]::new($false)

# Retry config for npm install + version-match (CDN propagation race
# after publish covers BOTH install failures AND stale dist-tag).
# Attempts = backoffs.Count + 1 so every backoff value is consumed:
# 6 attempts produce 5 sleeps totaling 5+10+15+20+30 = 80 seconds of
# propagation tolerance.
$installBackoffSeconds = @(5, 10, 15, 20, 30)
$installRetries = $installBackoffSeconds.Count + 1

# Locked Cat 2 denial wire-shape text (D99.O + R31 generic message).
$expectedDeniedText = 'MCP error -32602: Tool not found'

# Locked 8-tool order (D99.A).
$expectedToolOrder = @(
    'check_repo', 'explain_diff', 'classify_risk', 'list_risky_files', 'get_policy',
    'start_session', 'create_checkpoint', 'generate_fix_prompt'
)

# --- Pre-flight ------------------------------------------------------------

Write-Host '=== Pre-flight ==='
foreach ($tool in @('node', 'npm', 'npx', 'git')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "[FAIL] required tool not on PATH: $tool"
        exit 1
    }
    Write-Host "[ok] $tool on PATH"
}
if (-not (Test-Path $probeScript)) {
    Write-Host "[FAIL] MCP probe script not found: $probeScript"
    exit 1
}
Write-Host "[ok] MCP probe script: $probeScript"
Write-Host "[ok] Expected version: $ExpectedVersion"

try {
    # --- Scratch setup -----------------------------------------------------

    Write-Host ''
    Write-Host "=== Scratch dir: $scratch ==="
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    Push-Location $scratch
    try {
        # --- npm init ---------------------------------------------------------

        Write-Host ''
        Write-Host '=== npm init -y ==='
        & npm init -y | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "npm init -y failed (exit $LASTEXITCODE)" }
        Write-Host '[ok] scratch package.json initialized'

        # --- Install viberevert@beta + version-match with retry/backoff ----
        # Each attempt cleans prior install state so we observe whatever
        # the registry currently resolves @beta to. Retry covers BOTH
        # install failures AND CDN dist-tag staleness pointing at an
        # older beta version.

        Write-Host ''
        Write-Host "=== npm install viberevert@beta + version-match retry (target: $ExpectedVersion) ==="
        $resolvedOk = $false
        $lastInstalledVersion = ''
        $installedManifest = Join-Path $scratch 'node_modules/viberevert/package.json'
        for ($attempt = 1; $attempt -le $installRetries; $attempt++) {
            Write-Host "Attempt $attempt of $installRetries..."

            # Clean any prior install state so we get a fresh registry resolve.
            Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
            Remove-Item -Force package-lock.json -ErrorAction SilentlyContinue

            & npm install viberevert@beta --no-audit --no-fund 2>&1
            $npmExit = $LASTEXITCODE
            if ($npmExit -ne 0) {
                Write-Host "[warn] npm install exit $npmExit"
            } elseif (-not (Test-Path $installedManifest)) {
                Write-Host "[warn] npm install exit 0 but $installedManifest not found"
            } else {
                $installedPkg = Get-Content $installedManifest -Raw | ConvertFrom-Json
                $lastInstalledVersion = $installedPkg.version
                if ($lastInstalledVersion -eq $ExpectedVersion) {
                    $resolvedOk = $true
                    Write-Host "[ok] installed version matches expected: $lastInstalledVersion"
                    break
                }
                Write-Host "[warn] installed version $lastInstalledVersion != expected $ExpectedVersion (CDN/dist-tag propagation lag)"
            }

            if ($attempt -lt $installRetries) {
                $sleep = $installBackoffSeconds[$attempt - 1]
                Write-Host "Backing off $sleep seconds before retry..."
                Start-Sleep -Seconds $sleep
            }
        }
        if (-not $resolvedOk) {
            throw "Failed to resolve viberevert@beta == $ExpectedVersion after $installRetries attempts (last installed version: '$lastInstalledVersion'). npm registry propagation issue, unpublished version, or wrong dist-tag pointer."
        }

        # --- CLI surface checks: --version, doctor, init -------------------

        Write-Host ''
        Write-Host '=== npx viberevert --version ==='
        $versionOutput = & npx viberevert --version 2>&1
        $versionExit = $LASTEXITCODE
        if ($versionExit -ne 0) {
            throw "npx viberevert --version failed (exit $versionExit). Output:`n$($versionOutput -join "`n")"
        }
        $joinedVersion = ($versionOutput -join "`n")
        if (-not $joinedVersion.Contains($ExpectedVersion)) {
            throw "npx viberevert --version output does not contain expected version '$ExpectedVersion'. Got:`n$joinedVersion"
        }
        Write-Host "[ok] npx viberevert --version output contains $ExpectedVersion"

        Write-Host ''
        Write-Host '=== npx viberevert doctor ==='
        & npx viberevert doctor
        if ($LASTEXITCODE -ne 0) {
            throw "npx viberevert doctor failed (exit $LASTEXITCODE)"
        }
        Write-Host '[ok] npx viberevert doctor succeeded'

        Write-Host ''
        Write-Host '=== git init + npx viberevert init --profile generic ==='
        & git init --quiet
        if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
        & git config user.name 'Post-Publish Smoke'
        & git config user.email 'postpublish@example.com'
        & git config commit.gpgsign false
        'hello' | Out-File -FilePath 'README.md' -Encoding ascii
        "node_modules/" | Out-File -FilePath '.gitignore' -Encoding ascii
        & git add README.md .gitignore
        & git commit -q -m 'initial'
        if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
        Write-Host '[ok] scratch git repo initialized'

        & npx viberevert init --profile generic
        if ($LASTEXITCODE -ne 0) {
            throw "npx viberevert init --profile generic failed (exit $LASTEXITCODE)"
        }
        Write-Host '[ok] viberevert init succeeded'

        # --- MCP probe (FULL 7-frame Phase 12f transcript) -----------------

        Write-Host ''
        Write-Host '=== MCP stdio probe via scripts/mcp-stdio-probe.mjs (full Phase 12f 7-frame transcript) ==='

        # 7 input frames matching smoke-test.ps1 Phase 12f. Identical
        # transcript means published bytes prove the same MCP wire-
        # shape + audit locks that release-dry-run proves against
        # locally-packed bytes.
        $mcpRequests = @(
            '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"post-publish-smoke","version":"0.0.0"}}}',
            '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
            '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
            '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_policy","arguments":{}}}',
            '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rollback","arguments":{}}}',
            '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"request_human_approval","arguments":{}}}',
            '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"made_up_tool","arguments":{}}}'
        )
        $mcpInputBody = ($mcpRequests -join "`n") + "`n"

        $mcpInputFile = Join-Path $scratch 'mcp-input.jsonl'
        $mcpOutputFile = Join-Path $scratch 'mcp-output.jsonl'
        $mcpStderrFile = Join-Path $scratch 'mcp-stderr.txt'
        $mcpAuditPath = Join-Path $scratch '.viberevert/mcp-audit.log'

        # Write input with explicit no-BOM UTF-8.
        [System.IO.File]::WriteAllText($mcpInputFile, $mcpInputBody, $utf8NoBomMcp)

        # Belt-and-suspenders BOM check after write (Node probe also
        # enforces this on its end; Step 3 proved this class deserves
        # a double-guard at both layer boundaries).
        $writtenBytes = [System.IO.File]::ReadAllBytes($mcpInputFile)
        if ($writtenBytes.Length -ge 3 -and $writtenBytes[0] -eq 0xEF -and $writtenBytes[1] -eq 0xBB -and $writtenBytes[2] -eq 0xBF) {
            throw "Post-publish smoke: ${mcpInputFile} unexpectedly starts with UTF-8 BOM despite explicit UTF8Encoding(`$false) write"
        }

        $viberevertEntry = Join-Path $scratch 'node_modules/viberevert/dist/index.js'
        if (-not (Test-Path $viberevertEntry)) {
            throw "Installed viberevert entry not found at $viberevertEntry"
        }

        $probeOutput = & node $probeScript `
            --cwd $scratch `
            --entry $viberevertEntry `
            --input $mcpInputFile `
            --output $mcpOutputFile `
            --stderr $mcpStderrFile `
            --audit $mcpAuditPath 2>&1
        $probeExitCode = $LASTEXITCODE

        if ($probeExitCode -ne 0) {
            throw "MCP probe exit ${probeExitCode}:`n$($probeOutput -join "`n")"
        }
        # Silent-on-success contract.
        $probeOutputLines = @($probeOutput | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($probeOutputLines.Count -gt 0) {
            throw "MCP probe exit 0 but emitted unexpected output (probe must be silent on success):`n$($probeOutputLines -join "`n")"
        }
        Write-Host '[ok] MCP probe completed silently (exit 0)'

        # --- Validate MCP responses (6 expected: ids 1..6) ------------------

        Write-Host ''
        Write-Host '=== Validate MCP responses (mcp-output.jsonl: 6 expected) ==='
        $responseLines = @(Get-Content -Path $mcpOutputFile -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($responseLines.Count -ne 6) {
            throw "Expected 6 response lines in ${mcpOutputFile}, got $($responseLines.Count). Lines:`n$($responseLines -join "`n")"
        }
        $responses = @{}
        foreach ($line in $responseLines) {
            $parsed = $line | ConvertFrom-Json
            if ($null -eq $parsed.id) {
                throw "Response missing id field: $line"
            }
            $idInt = [int]$parsed.id
            if ($responses.ContainsKey($idInt)) {
                throw "Duplicate JSON-RPC response id=${idInt} in ${mcpOutputFile}"
            }
            $responses[$idInt] = $parsed
        }
        foreach ($id in @(1, 2, 3, 4, 5, 6)) {
            if (-not $responses.ContainsKey($id)) {
                throw "Missing JSON-RPC response id=$id. Got ids: $($responses.Keys -join ',')"
            }
        }
        Write-Host '[ok] mcp-output.jsonl: exactly 6 responses (ids 1..6) parsed'

        # id=1: initialize protocolVersion (D99.Y locked)
        if ($responses[1].result.protocolVersion -ne '2025-06-18') {
            throw "id=1 initialize: protocolVersion mismatch: expected '2025-06-18', got '$($responses[1].result.protocolVersion)'"
        }
        Write-Host '[ok] id=1 initialize: protocolVersion=2025-06-18'

        # id=2: tools/list exact order (D99.A) + no reserved names (D99.B)
        $actualTools = @($responses[2].result.tools | ForEach-Object { $_.name })
        if ($actualTools.Count -ne 8) {
            throw "id=2 tools/list: expected 8 tools, got $($actualTools.Count): $($actualTools -join ',')"
        }
        for ($i = 0; $i -lt 8; $i++) {
            if ($actualTools[$i] -ne $expectedToolOrder[$i]) {
                throw "id=2 tools/list: tool[$i] expected '$($expectedToolOrder[$i])', got '$($actualTools[$i])' (D99.A order lock)"
            }
        }
        foreach ($reserved in @('rollback', 'request_human_approval')) {
            if ($actualTools -contains $reserved) {
                throw "id=2 tools/list: reserved name '$reserved' MUST NOT appear (D99.B)"
            }
        }
        Write-Host "[ok] id=2 tools/list: 8 tools in locked D99.A order; no reserved names"

        # id=3: get_policy Cat 1 success (D99.O)
        $getPolicyResp = $responses[3]
        if ($getPolicyResp.result.isError) {
            throw "id=3 get_policy: expected isError absent/false (Cat 1), got isError=$($getPolicyResp.result.isError)"
        }
        if (-not $getPolicyResp.result.structuredContent.ok) {
            throw "id=3 get_policy: expected structuredContent.ok=true, got $($getPolicyResp.result.structuredContent | ConvertTo-Json -Compress)"
        }
        Write-Host '[ok] id=3 get_policy: Cat 1 success; structuredContent.ok=true'

        # id=4/5/6: Cat 2 denials (D99.O + R31) -- identical wire shape
        foreach ($denial in @(@{id=4; name='rollback'}, @{id=5; name='request_human_approval'}, @{id=6; name='made_up_tool'})) {
            $resp = $responses[$denial.id]
            if (-not $resp.result.isError) {
                throw "id=$($denial.id) $($denial.name): expected result.isError=true (Cat 2)"
            }
            $content = @($resp.result.content)
            if ($content.Count -ne 1) {
                throw "id=$($denial.id) $($denial.name): expected 1 content entry, got $($content.Count)"
            }
            if ($content[0].type -ne 'text') {
                throw "id=$($denial.id) $($denial.name): content[0].type expected 'text', got '$($content[0].type)'"
            }
            if ($content[0].text -ne $expectedDeniedText) {
                throw "id=$($denial.id) $($denial.name): text expected exactly '$expectedDeniedText' (R31 generic; tool name MUST NOT be echoed), got '$($content[0].text)'"
            }
            if ($null -ne $resp.result.structuredContent) {
                throw "id=$($denial.id) $($denial.name): Cat 2 MUST NOT have structuredContent (D99.O)"
            }
        }
        Write-Host '[ok] id=4/5/6 denials: identical Cat 2 wire shape (D99.O + R31)'

        # id=6: R31 raw-name absence -- "made_up_tool" MUST NOT appear in response JSON
        $id6Json = ($responses[6] | ConvertTo-Json -Compress -Depth 10)
        if ($id6Json.Contains('made_up_tool')) {
            throw "id=6 made_up_tool: raw unknown name leaked into response JSON (R31 violation)"
        }
        Write-Host '[ok] id=6: raw unknown name made_up_tool NOT in response (R31 reflection lock)'

        # --- Validate audit log (4 records: 1 tool_call + 3 denials) -------

        Write-Host ''
        Write-Host '=== Validate audit log (.viberevert/mcp-audit.log: 4 expected) ==='
        if (-not (Test-Path $mcpAuditPath)) {
            throw "Audit log not found at $mcpAuditPath"
        }
        $auditLines = @(Get-Content -Path $mcpAuditPath -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($auditLines.Count -ne 4) {
            throw "Expected exactly 4 audit records, got $($auditLines.Count). Records:`n$($auditLines -join "`n")"
        }
        $auditRecords = @($auditLines | ForEach-Object { $_ | ConvertFrom-Json })

        $getPolicyAudit = @($auditRecords | Where-Object { $_.event -eq 'tool_call' -and $_.tool_name -eq 'get_policy' })
        if ($getPolicyAudit.Count -ne 1) {
            throw "Expected exactly 1 tool_call audit record for get_policy, got $($getPolicyAudit.Count)"
        }
        if ($getPolicyAudit[0].ok -ne $true) {
            throw "tool_call get_policy audit: ok expected true, got $($getPolicyAudit[0].ok)"
        }
        Write-Host '[ok] audit: 1 tool_call get_policy ok:true record'

        foreach ($expectedName in @('rollback', 'request_human_approval', '<unknown>')) {
            $denialAudit = @($auditRecords | Where-Object { $_.event -eq 'tool_call_denied' -and $_.tool_name -eq $expectedName })
            if ($denialAudit.Count -ne 1) {
                throw "Expected exactly 1 tool_call_denied audit record for tool_name='$expectedName', got $($denialAudit.Count)"
            }
            if ($denialAudit[0].error_code -ne 'TOOL_NOT_FOUND') {
                throw "tool_call_denied ${expectedName}: error_code expected 'TOOL_NOT_FOUND', got '$($denialAudit[0].error_code)'"
            }
        }
        Write-Host '[ok] audit: 3 tool_call_denied records (rollback + request_human_approval + <unknown>) all TOOL_NOT_FOUND'

        # Cross-record: raw "made_up_tool" MUST NOT appear (R31 sentinel)
        $auditFullText = ($auditLines -join "`n")
        if ($auditFullText.Contains('made_up_tool')) {
            throw "Audit cross-record: raw unknown name 'made_up_tool' leaked into audit log (R31 sentinel violation)"
        }
        Write-Host '[ok] audit cross-record: raw made_up_tool NOT in audit (R31 sentinel substitution verified)'

        # --- All assertions passed ------------------------------------------

        Write-Host ''
        Write-Host '=== Summary ==='
        Write-Host "[ALL PASS] Published viberevert@$ExpectedVersion validated end-to-end:"
        Write-Host '  - npm install + version-match resolved within retry budget'
        Write-Host "  - installed package.json version = $ExpectedVersion"
        Write-Host "  - npx viberevert --version output contains $ExpectedVersion"
        Write-Host '  - npx viberevert doctor succeeded'
        Write-Host '  - npx viberevert init --profile generic succeeded'
        Write-Host '  - MCP stdio probe: full 7-frame Phase 12f transcript (6 responses) via Node probe'
        Write-Host '  - MCP wire-shape: D99.Y protocolVersion, D99.A 8-tool order, D99.B reserved hiding, D99.O Cat 1/Cat 2, R31 reflection locks'
        Write-Host '  - MCP audit: 4 records (1 tool_call get_policy ok:true + 3 tool_call_denied)'
        Write-Host '  - MCP server exited 0 cleanly with empty stderr'

        $succeeded = $true
    } finally {
        Pop-Location
    }
} finally {
    if ($succeeded -and -not $KeepArtifacts) {
        Write-Host ''
        Write-Host "Cleaning up scratch dir: $scratch"
        Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
    } elseif ($succeeded) {
        Write-Host ''
        Write-Host "Scratch dir preserved (-KeepArtifacts): $scratch"
    } else {
        Write-Host ''
        Write-Host "Scratch dir preserved for failure diagnostics: $scratch"
    }
}

exit 0
