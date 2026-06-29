---
name: windows-agent-safety
description: Windows/PowerShell safety guardrails for Claude agents. Trigger before any destructive file-system, build-cleanup, or repo-mutating action on Windows.
trigger: windows safety, destructive, delete repo, remove-item, rimraf, cleanup, powershell
compatibility: claude
---

# /windows-agent-safety — Windows/PowerShell Destruction Prevention

This skill exists because Windows + PowerShell + frustrated agents have repeatedly destroyed unrecoverable work. The acp-desktop deletion incident (2026-06-29) is the canonical example: a build cleanup escalated until an entire repo, its `.git` directory, built installer artifacts, and the sibling `acp-api` tree disappeared.

## Core rule

**If an action is destructive and you cannot trivially undo it, STOP and raise a gate flag. Do not "just go for it."**

Destructive = deletes, overwrites, moves, rebases, force-pushes, registry edits, service stops, installer runs, container/volume prunes, or any command with `-Force`, `-Recurse`, `rm -rf`, `rimraf`, `reset --hard`, `push --force`, `prune`, `drop`, `filter-branch`, etc.

## What happened to acp-desktop

NightHawk was executing a build-only task (`npm run dist:win -- --publish never`). After repeated failures, he attempted to force-delete the locked `acp-api-release` directory with:

```batch
cmd /c "rmdir /s /q \"\\?\E:\Repos\acp-desktop\acp-api-release\""
```

The shell misinterpreted the `\\?\` long-path prefix. Instead of deleting only `acp-api-release`, the command destroyed:

- `E:\Repos\acp-desktop\` — entire source tree, `.git`, `release/`, build artifacts
- `E:\Repos\acp-api\` — missing entirely
- `E:\Repos\.tmp\` — QAPert's T1-T5 matrix file
- partial damage to `E:\Repos\.iv-devpass\` and `E:\Repos\idealvibe.online\`

**Lesson:** manual cleanup during a failing build is one of the most dangerous things an agent can do on Windows.

## The Windows/PowerShell traps

### 1. `2>&1 | Tee-Object` turns warnings into "failures"

PowerShell 5.1 treats stderr streams written through `2>&1` as `ErrorRecord` objects. When the pipeline ends with `Tee-Object`, the last error record can set `$? = $false` and make the whole command return exit code 1 even when the actual build succeeded.

**What it looks like:**

```text
npm : npm warn config production Use `--omit=dev` instead.
...
+ CategoryInfo          : NotSpecified: (...):String) [], RemoteException
...
```

**Do not conclude the build failed just because of this.** Verify artifacts exist and are valid before retrying or escalating.

**Safer patterns:**

```powershell
# Redirect warnings to a file instead of the success stream
npm run dist:win -- --publish never 3>build-warnings.txt

# Or capture stdout and stderr separately
$out = npm run dist:win -- --publish never 2>build-stderr.txt
```

### 2. `Remove-Item -Recurse -Force` is a loaded gun

PowerShell will delete a directory tree with no confirmation if `-Force` is present. A mis-resolved variable or unexpected cwd makes it catastrophic.

**Forbidden without explicit user GO:**

```powershell
Remove-Item -Recurse -Force $somePath
Remove-Item -Recurse -Force release\win-unpacked
Remove-Item -Recurse -Force node_modules
Remove-Item -Recurse -Force acp-api-release
npx rimraf anything
npx rimraf .
npx rimraf ..
```

**Required safety pattern:**

```powershell
$target = Resolve-Path -LiteralPath "release\win-unpacked" -ErrorAction SilentlyContinue
if (-not $target) {
    Write-Host "Target does not exist; nothing to delete."
    return
}

# Verify it is still inside the project root
$projectRoot = Resolve-Path "E:\repos\acp-desktop"
if (-not $target.Path.StartsWith($projectRoot.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ABORT: resolved target $target is outside project root $projectRoot"
}

# List what will be deleted
Get-ChildItem -LiteralPath $target.Path -Recurse -Depth 2 | Select-Object FullName | Format-Table -AutoSize

# Then use -WhatIf first
Remove-Item -LiteralPath $target.Path -Recurse -Force -WhatIf

# Only after human GO or a verified script remove -WhatIf
```

### 3. `npx rimraf` follows junctions/symlinks

`rimraf` is Node-based and can follow directory junctions on Windows unexpectedly. Do not use it for project cleanup. Use project-provided npm scripts or explicit `Remove-Item` with the safety pattern above.

### 4. The `\\?\` long-path prefix with `cmd /c rmdir /s /q`

This combination is especially dangerous because:
- `cmd /c` introduces an extra layer of quote/escape parsing.
- `\\?\` disables path normalization, so relative components or malformed paths behave unpredictably.
- `rmdir /s /q` gives no confirmation and no recycle-bin recovery.

**Never use this pattern.** If you hit MAX_PATH during cleanup, stop and ask the user. Do not self-rescue with force-delete commands.

### 5. Relative paths during a failing build are unreliable

A failed `npm run dist:win` can leave:

- the current working directory changed
- partial `release\` contents
- locked files that make subsequent commands behave differently
- environment variables set/unset unexpectedly

**Always use absolute, resolved paths for destructive commands.** Never rely on `.", `..`, or `$PWD` after a command has failed.

### 6. `Out-File -Encoding utf8` writes a UTF-8 BOM

PowerShell 5.1 `Out-File -Encoding utf8` prepends a BOM. This breaks JSON parsers, Vite, PostCSS, and API endpoints with "input does not contain any JSON tokens" or "Unexpected token '﻿'".

**Safe alternatives:**

```powershell
# For API JSON bodies
$json = $payload | ConvertTo-Json -Depth 6 -Compress
Invoke-RestMethod -Uri ... -Body $json -ContentType "application/json; charset=utf-8"

# For writing files without BOM
[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))

# For appending without BOM
$bytes = [System.Text.Encoding]::UTF8.GetBytes($content)
[System.IO.File]::AppendAllBytes($path, $bytes)
```

### 7. Windows paths are case-insensitive and can contain spaces

A variable like `$repo = "acp-desktop"` vs `$repo = "ACP-Desktop"` resolves to the same folder. This makes string-based safety checks unreliable. Use `Resolve-Path` and `FullName` comparisons.

### 8. `git clean -fdx`, `git reset --hard`, `git push --force` are destructive

These are irreversible. Treat them as gated actions.

## Gated action protocol

Use for every destructive/irreversible command:

1. **Identify** the destructive action.
2. **Verify the target** with `Resolve-Path` / `Get-Item` / `Test-Path`.
3. **Confirm it is inside the project/working directory** and not a parent, sibling, or system path.
4. **List what will be affected** (files, commits, running services).
5. **Raise a gate flag** in mail/chat: "This is destructive/irreversible: [action]. I am holding for explicit GO."
6. **Wait for explicit GO** from the lead or user. Silence != proceed.
7. **Use `-WhatIf` first** when possible, then execute with the verified absolute path.
8. **Verify the result** and report.

## Build cleanup: the safe way

Instead of manual `Remove-Item` / `rimraf` during a failing build:

1. Stop and read the actual error.
2. Check whether the project has a clean script:
   ```powershell
   npm run clean
   npm run clean:dist
   ```
3. If not, use the verified project scripts or ask the user.
4. Do not delete `node_modules` as a first troubleshooting step.
5. Do not move `release\` artifacts around manually unless the user explicitly asked.

## Quick checklist before any destructive Windows command

- [ ] Is this the minimal scope needed?
- [ ] Is the path absolute and resolved with `Resolve-Path`?
- [ ] Is the target still inside the project root?
- [ ] Have I listed what will be deleted/overwritten?
- [ ] Have I used `-WhatIf` first (PowerShell) or `--dry-run` (git)?
- [ ] Is this a gated action that needs explicit GO?
- [ ] Can I undo it if something goes wrong?

## When you are frustrated

If a build has failed more than twice and you are tempted to "just nuke it and start over":

1. Stop.
2. Tell the user/lead exactly what is failing and what you want to delete.
3. Wait for explicit GO.
4. Frustration is not a reason to bypass safety checks.

## PowerShell safety baseline (loaded automatically)

Every Windows PowerShell session should load the ACP safety profile and module:

- Profile: `C:\Users\jon-local\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`
- Module: `E:\repos\.acp\powershell\ACPSafety\ACPSafety.psm1`
- Best practices: `E:\repos\.acp\powershell\powershell-best-practices.md`

The profile enforces:
- UTF-8 console output
- `$ErrorActionPreference = 'Stop'`
- `Set-StrictMode -Version Latest`
- Removal of the `curl` alias
- Auto-import of `ACPSafety`

Use the module helpers:
- `Test-InsideProject -Path <path>`
- `Remove-SafeDirectory -Path <path> -WhatIf`
- `Write-NoBomFile -Path <path> -Content <text>`
- `Invoke-SafeNativeCommand -FilePath <exe> -ArgumentList @(...)`
- `Show-DestructiveWarning -Action <description>`

## Escalation phrase

Use this exact framing when you need a human decision:

> "This is a destructive/irreversible action: [describe]. I am holding for explicit GO. Do not proceed until you confirm."
