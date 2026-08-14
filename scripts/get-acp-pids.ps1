# Quick script to get ACP process PIDs for fast shutdown
# Usage: . .\scripts\get-acp-pids.ps1

$electronPid = Get-Process | Where-Object { $_.ProcessName -eq "acp-desktop" } | Select-Object -First 1 -ExpandProperty Id
$nodePid = Get-Process | Where-Object { $_.ProcessName -eq "node" -and $_.CommandLine -match "acp-api" } | Select-Object -First 1 -ExpandProperty Id

if ($electronPid) {
  Write-Host "ACP Electron: PID $electronPid"
}

if ($nodePid) {
  Write-Host "ACP API (node): PID $nodePid"
}

if (-not $electronPid -and -not $nodePid) {
  Write-Host "No ACP processes found"
}

# Export for use in shutdown script
$env:ACP_ELECTRON_PID = $electronPid
$env:ACP_NODE_PID = $nodePid

Write-Host ""
Write-Host "Fast shutdown:"
Write-Host "  python scripts/shutdown-with-summaries.py --kill-pid $nodePid"
