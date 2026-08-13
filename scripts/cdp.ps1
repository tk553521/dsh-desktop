# CDP helper for the DSH Desktop WebView2 (debug builds expose :9333).
# Modes:
#   .\cdp.ps1 -Eval "document.title"
#   .\cdp.ps1 -Eval "..." -Match "127.0.0.1"    (pick a specific page target)
#   .\cdp.ps1 -Shot out.png [-Match "127.0.0.1"]
param(
  [string]$Eval,
  [string]$Shot,
  [string]$Match = "",
  [int]$Port = 9333,
  [switch]$List
)

$ErrorActionPreference = "Stop"

function Get-Target {
  $targets = Invoke-RestMethod "http://127.0.0.1:$Port/json" -TimeoutSec 5
  if ($List) {
    $targets | Where-Object { $_.type -eq "page" } | ForEach-Object { "{0}  {1}" -f $_.id, $_.url }
    return $null
  }
  $t = $targets | Where-Object { $_.type -eq "page" -and ($_.url -match $Match) } | Select-Object -First 1
  if (-not $t) { $t = $targets | Where-Object { $_.type -eq "page" } | Select-Object -First 1 }
  return $t
}

function Send-Cdp([string]$url, [hashtable]$payload) {
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $ws.ConnectAsync([Uri]$url, [Threading.CancellationToken]::None).Wait()
  $json = $payload | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
  $buf = New-Object byte[] 262144
  $sb = New-Object Text.StringBuilder
  do {
    $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Result
    [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
  } while (-not $res.EndOfMessage)
  $ws.Dispose()
  return ($sb.ToString() | ConvertFrom-Json)
}

$t = Get-Target
if ($List) { return }
if (-not $t) { Write-Error "no page target found on port $Port"; exit 1 }
Write-Host ("target: {0} {1}" -f $t.id, $t.url) -ForegroundColor DarkGray

if ($Eval) {
  $r = Send-Cdp $t.webSocketDebuggerUrl @{ id = 1; method = "Runtime.evaluate"; params = @{ expression = $Eval; returnByValue = $true; awaitPromise = $true } }
  if ($r.result.exceptionDetails) {
    Write-Host ("EXCEPTION: {0}" -f $r.result.exceptionDetails.text) -ForegroundColor Red
  } elseif ($null -ne $r.result.result.value) {
    $r.result.result.value | ConvertTo-Json -Depth 12
  } elseif ($r.result.result.description) {
    $r.result.result.description
  } else {
    "OK (no value)"
  }
}

if ($Shot) {
  $r = Send-Cdp $t.webSocketDebuggerUrl @{ id = 2; method = "Page.captureScreenshot"; params = @{ format = "png" } }
  if ($r.result.data) {
    $outPath = if ([IO.Path]::IsPathRooted($Shot)) { $Shot } else { (Resolve-Path ".").Path + "\" + $Shot }
    [IO.File]::WriteAllBytes($outPath, [Convert]::FromBase64String($r.result.data))
    "screenshot saved: $outPath"
  } else {
    "capture failed"
  }
}
