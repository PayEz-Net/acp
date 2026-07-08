# ACP crash/restart monitor
$logFile = "E:\repos\acp-desktop\acp-restart-monitor.log"
function Log($msg) {
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $msg
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    Write-Host $line
}

Log "Monitor started. Watching ACP processes."
$wasRunning = $false
while ($true) {
    $procs = Get-Process | Where-Object { $_.ProcessName -eq 'ACP' }
    $isRunning = $procs.Count -gt 0
    if ($isRunning -and -not $wasRunning) {
        $info = $procs | Select-Object -First 1
        Log "ACP STARTED: PID=$($info.Id), StartTime=$($info.StartTime), Path=$($info.Path)"
    }
    if (-not $isRunning -and $wasRunning) {
        Log "ACP STOPPED at $(Get-Date)"
        # Capture recent event log entries immediately
        try {
            $events = Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2,3; StartTime=(Get-Date).AddMinutes(-2)} -MaxEvents 10 -ErrorAction SilentlyContinue | Where-Object { $_.Message -like '*ACP*' -or $_.ProviderName -eq 'Application Error' }
            foreach ($e in $events) { Log "  Event: $($e.TimeCreated) $($e.ProviderName) Id=$($e.Id) $($e.Message.Substring(0,[Math]::Min(200,$e.Message.Length)))" }
        } catch { Log "  Could not fetch events: $_" }
    }
    $wasRunning = $isRunning
    Start-Sleep -Seconds 5
}
