#Requires -Version 5.1
<#
.SYNOPSIS
    ACP Safety module for Windows PowerShell.

.DESCRIPTION
    Helper functions and defaults to prevent destructive mistakes by AI agents
    running on Windows/PowerShell. Import this module in every agent session.
#>

#region Safe defaults
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$script:ACPProjectRoots = @(
    'E:\repos',
    'E:\src'
)
#endregion

function Test-InsideProject {
    <#
    .SYNOPSIS
        Verifies that a resolved path is inside one of the allowed project roots.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [string[]]$AllowedRoots = $script:ACPProjectRoots
    )

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $resolved) {
        Write-Warning "Path does not exist or cannot be resolved: $Path"
        return $false
    }

    foreach ($root in $AllowedRoots) {
        $resolvedRoot = Resolve-Path -LiteralPath $root -ErrorAction SilentlyContinue
        if (-not $resolvedRoot) { continue }
        if ($resolved.Path.StartsWith($resolvedRoot.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Remove-SafeDirectory {
    <#
    .SYNOPSIS
        Removes a directory only after verifying it is inside the project root.
        Supports -WhatIf.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [switch]$Force
    )

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $resolved) {
        Write-Host "Remove-SafeDirectory: target does not exist, nothing to do: $Path"
        return
    }

    if (-not (Test-InsideProject -Path $resolved.Path)) {
        throw "ABORT: refusing to delete '$($resolved.Path)' because it is outside the allowed project roots."
    }

    $items = Get-ChildItem -LiteralPath $resolved.Path -Recurse -ErrorAction SilentlyContinue | Measure-Object
    Write-Host "Remove-SafeDirectory: target '$($resolved.Path)' contains $($items.Count) items."

    if ($PSCmdlet.ShouldProcess($resolved.Path, 'Remove directory recursively')) {
        Remove-Item -LiteralPath $resolved.Path -Recurse -Force:$Force
        Write-Host "Remove-SafeDirectory: deleted '$($resolved.Path)'"
    }
}

function Write-NoBomFile {
    <#
    .SYNOPSIS
        Writes text to a file as UTF-8 without BOM.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Content,

        [switch]$Append
    )

    $encoding = [System.Text.UTF8Encoding]::new($false)
    $resolvedDir = Split-Path -Parent -Path $Path
    if ($resolvedDir -and -not (Test-Path $resolvedDir)) {
        New-Item -ItemType Directory -Path $resolvedDir -Force | Out-Null
    }

    if ($Append) {
        $bytes = $encoding.GetBytes($Content)
        [System.IO.File]::AppendAllBytes($Path, $bytes)
    } else {
        [System.IO.File]::WriteAllText($Path, $Content, $encoding)
    }
}

function Invoke-SafeNativeCommand {
    <#
    .SYNOPSIS
        Runs a native command and captures stdout/stderr separately so that
        stderr warnings do not pollute the PowerShell error stream.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$ArgumentList,

        [string]$WorkingDirectory,

        [int]$TimeoutSeconds = 1800
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ($ArgumentList | ForEach-Object { '"{0}"' -f ($_.Replace('"', '\"')) }) -join ' '
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if ($WorkingDirectory) {
        $psi.WorkingDirectory = $WorkingDirectory
    }

    $process = [System.Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill()
        throw "Command timed out after $TimeoutSeconds seconds: $FilePath $psi.Arguments"
    }

    return [PSCustomObject]@{
        ExitCode = $process.ExitCode
        StdOut   = $stdout
        StdErr   = $stderr
    }
}

function Show-DestructiveWarning {
    <#
    .SYNOPSIS
        Prints the standard destructive-action gate flag phrase.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Action
    )

    Write-Warning "This is a destructive/irreversible action: $Action. I am holding for explicit GO. Do not proceed until you confirm."
}

Export-ModuleMember -Function @(
    'Test-InsideProject',
    'Remove-SafeDirectory',
    'Write-NoBomFile',
    'Invoke-SafeNativeCommand',
    'Show-DestructiveWarning'
)
