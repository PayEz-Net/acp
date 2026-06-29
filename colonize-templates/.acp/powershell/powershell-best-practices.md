# PowerShell Best Practices for ACP Agents on Windows

This document is the companion to the `windows-agent-safety` skill. It defines the baseline PowerShell environment and conventions every agent must use on Windows.

## 1. Always use absolute, resolved paths

Before any destructive operation, resolve the path and verify it is inside the project root.

```powershell
$target = Resolve-Path -LiteralPath "release\win-unpacked" -ErrorAction SilentlyContinue
$projectRoot = Resolve-Path "E:\repos\acp-desktop"
if (-not $target.Path.StartsWith($projectRoot.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ABORT: target is outside project root"
}
```

## 2. Never use `2>&1 | Tee-Object` for builds

This pattern turns stderr warnings into terminating-looking errors and sets exit code 1 even when the build succeeded.

**Bad:**
```powershell
npm run dist:win 2>&1 | Tee-Object build.log
```

**Good:**
```powershell
npm run dist:win 3>warnings.txt
# or capture separately
$stdout = npm run dist:win 2>stderr.txt
```

## 3. Write UTF-8 without BOM

PowerShell 5.1 `Out-File -Encoding utf8` prepends a BOM that breaks JSON parsers, Vite, PostCSS, and APIs.

**Bad:**
```powershell
$json | Out-File -FilePath config.json -Encoding utf8
```

**Good:**
```powershell
[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
```

## 4. Do not use `curl` in PowerShell

In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`, which behaves differently than real curl and can mangle Unicode.

**Use `Invoke-RestMethod` instead:**
```powershell
$headers = @{ "X-ACP-Agent" = "BAPert" }
$result = Invoke-RestMethod -Uri "http://127.0.0.1:3001/v1/mail/inbox/BAPert" -Headers $headers
```

## 5. Treat locked directories as a process problem, not a cleanup problem

If a directory is locked, a process is holding it open. Find and stop the process. Do not force-delete.

```powershell
Get-Process | Where-Object { $_.Path -like "*E:\repos\acp-desktop*" }
```

## 6. Use `-WhatIf` before destructive commands

```powershell
Remove-Item -LiteralPath $target.Path -Recurse -Force -WhatIf
# Verify output, then remove -WhatIf
```

## 7. Forbidden commands without explicit GO

Never run these without human approval:

- `Remove-Item -Recurse -Force`
- `rmdir /s /q`
- `rm -rf`
- `npx rimraf <path>`
- `git clean -fdx`
- `git reset --hard`
- `git push --force`
- `format`, `diskpart`, `robocopy /MIR` on live data

## 8. Build cleanup must use project scripts

If a build fails on cleanup, use the project's clean script or fix the script. Do not run ad-hoc destructive commands.

```powershell
npm run clean
npm run clean:dist
```

## 9. Stop on repeated failures

If the same step fails three times, stop and escalate. Do not escalate the force of the cleanup.

## 10. Snapshot before destructive maintenance

Before any bulk cleanup, create a quick backup:

```powershell
robocopy E:\repos\acp-desktop E:\backups\acp-desktop-pre-cleanup /MIR /FFT /Z /XA:H
```

## 11. Required PowerShell defaults

The agent profile should set:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8NoBom'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Remove-Item Alias:\curl -ErrorAction SilentlyContinue
```

## 12. Use the `ACPSafety` module

Import the module in every session:

```powershell
Import-Module E:\repos\.acp\powershell\ACPSafety\ACPSafety.psm1
```

Available helpers:
- `Test-InsideProject`
- `Remove-SafeDirectory`
- `Write-NoBomFile`
- `Invoke-SafeNativeCommand`

## 13. Gated action phrase

When you need a human decision:

> "This is a destructive/irreversible action: [describe]. I am holding for explicit GO. Do not proceed until you confirm."
