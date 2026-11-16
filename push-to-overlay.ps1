param()
$ErrorActionPreference = 'SilentlyContinue'

# Read the Stop hook stdin (has session_id)
$raw = [Console]::In.ReadToEnd()
try { $data = $raw | ConvertFrom-Json } catch { exit 0 }

$sessionId = $data.session_id
if (-not $sessionId) { exit 0 }

# Log that the hook fired
"$(Get-Date -Format 'HH:mm:ss') Stop hook fired for $sessionId" | Add-Content "$env:USERPROFILE\.claude\obs-hook.log" -ErrorAction SilentlyContinue

# Find transcript JSONL for this session
$claudeBase = "$env:USERPROFILE\.claude"
$transcriptFile = Get-ChildItem -Path $claudeBase -Filter "$sessionId.jsonl" -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $transcriptFile) {
    "$(Get-Date -Format 'HH:mm:ss') No transcript found" | Add-Content "$env:USERPROFILE\.claude\obs-hook.log" -ErrorAction SilentlyContinue
    exit 0
}

# Poll for the final assistant message — stop as soon as we find one,
# retry up to 3 times with 400ms gaps (avoids sleeping past next turn)
$lastText = ''
for ($i = 0; $i -lt 3; $i++) {
    Start-Sleep -Milliseconds 400
    $lines = Get-Content $transcriptFile.FullName -Tail 30 -ErrorAction SilentlyContinue
    foreach ($line in [Linq.Enumerable]::Reverse([string[]]$lines)) {
        if (-not $line.Trim()) { continue }
        try {
            $obj = $line | ConvertFrom-Json -ErrorAction SilentlyContinue
            if (-not $obj -or -not $obj.message) { continue }
            if ($obj.message.role -ne 'assistant') { continue }
            $textBlocks = $obj.message.content | Where-Object { $_.type -eq 'text' -and $_.text -and $_.text.Trim() }
            if ($textBlocks) { $lastText = ($textBlocks | Select-Object -Last 1).text.Trim(); break }
        } catch {}
    }
    if ($lastText) { break }
}

"$(Get-Date -Format 'HH:mm:ss') Last text found: $($lastText.Substring(0,[Math]::Min(80,$lastText.Length)))" | Add-Content "$env:USERPROFILE\.claude\obs-hook.log" -ErrorAction SilentlyContinue

if (-not $lastText) { exit 0 }

# Only show overlay when Claude is asking a question
$isQuestion = $lastText -match '\?\s*$'

if (-not $isQuestion) {
    try {
        Invoke-RestMethod -Uri 'http://localhost:3000/api/idle' -Method POST -TimeoutSec 2 | Out-Null
    } catch {}
    exit 0
}

# Trim to 350 chars
if ($lastText.Length -gt 350) { $lastText = $lastText.Substring(0, 347) + '...' }

$body = ConvertTo-Json @{ message = $lastText; type = 'question' } -Compress
try {
    Invoke-RestMethod -Uri 'http://localhost:3000/api/update' `
        -Method POST -ContentType 'application/json' -Body $body `
        -TimeoutSec 2 | Out-Null
} catch {}
