#
# ACP Agent Skills Installer (Windows)
# Usage: Invoke-WebRequest ... | Invoke-Expression
#

$SkillsVersion = "1.0.0"
$SkillsRepo = "https://github.com/PayEz-Net/acp/raw/main/skills"
$CommandsRepo = "https://github.com/PayEz-Net/acp/raw/main/.agents/commands"
$TargetDir = "$env:USERPROFILE\.kimi\skills"
$CommandsTargetDir = "$env:USERPROFILE\.claude\commands"
$BackupDir = "$env:USERPROFILE\.kimi\skills.backup.$(Get-Date -Format 'yyyyMMddHHmmss')"

# Claude Code slash commands sourced from acp-desktop/.agents/commands/.
# Each entry maps 1:1 to a file in ~/.claude/commands/ after install.
$Commands = @(
    'agent-docs.md',
    'agent-mail.md',
    'vibe-sql.md'
)

function Print-Banner {
    Write-Host @"
╔════════════════════════════════════════════════════════╗
║        ACP Agent Skills Installer v$SkillsVersion           ║
╚════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan
}

function Print-Success($msg) {
    Write-Host "✓ $msg" -ForegroundColor Green
}

function Print-Warning($msg) {
    Write-Host "⚠ $msg" -ForegroundColor Yellow
}

function Print-Error($msg) {
    Write-Host "✗ $msg" -ForegroundColor Red
}

function Print-Info($msg) {
    Write-Host "ℹ $msg" -ForegroundColor Cyan
}

function Test-Prerequisites {
    Print-Info "Checking prerequisites..."
    
    # Check PowerShell version
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        Print-Error "PowerShell 5.0 or later is required"
        exit 1
    }
    
    Print-Success "Prerequisites met"
}

function Backup-Existing {
    if (Test-Path $TargetDir) {
        Print-Warning "Existing skills found. Creating backup..."
        New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
        Copy-Item -Path "$TargetDir\*" -Destination $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
        Print-Success "Backup created at $BackupDir"
    }
}

function Install-Skills {
    Print-Info "Installing ACP Agent Skills..."
    
    # Create target directory
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    
    # Download each skill
    $skills = @('agent-onboarding', 'gitnexus-code', 'vibe-sql')
    
    foreach ($skill in $skills) {
        Print-Info "Downloading $skill..."
        $skillDir = Join-Path $TargetDir $skill
        New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
        
        $url = "$SkillsRepo/$skill/SKILL.md"
        $outFile = Join-Path $skillDir "SKILL.md"
        
        try {
            Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
            Print-Success "Installed $skill"
        }
        catch {
            Print-Error "Failed to download $skill`: $_"
        }
    }
    
    # Download manifest
    $manifestUrl = "$SkillsRepo/acp-skills.json"
    $manifestOut = Join-Path $TargetDir "acp-skills.json"
    Invoke-WebRequest -Uri $manifestUrl -OutFile $manifestOut -UseBasicParsing -ErrorAction SilentlyContinue

    Print-Success "All skills installed to $TargetDir"
}

function Install-Commands {
    Print-Info "Installing Claude Code slash commands..."

    # Create target directory for Claude commands
    New-Item -ItemType Directory -Force -Path $CommandsTargetDir | Out-Null

    foreach ($command in $Commands) {
        Print-Info "Downloading $command..."
        $url = "$CommandsRepo/$command"
        $outFile = Join-Path $CommandsTargetDir $command

        try {
            Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
            Print-Success "Installed $command"
        }
        catch {
            Print-Error "Failed to download $command`: $_"
        }
    }

    Print-Success "All commands installed to $CommandsTargetDir"
}

function Test-Installation {
    Print-Info "Verifying installation..."

    $allGood = $true
    $skills = @('agent-onboarding', 'gitnexus-code', 'vibe-sql')

    foreach ($skill in $skills) {
        $skillFile = Join-Path $TargetDir "$skill\SKILL.md"
        if (Test-Path $skillFile) {
            Print-Success "$skill skill present"
        }
        else {
            Print-Error "$skill skill missing"
            $allGood = $false
        }
    }

    foreach ($command in $Commands) {
        $commandFile = Join-Path $CommandsTargetDir $command
        if (Test-Path $commandFile) {
            Print-Success "$command command present"
        }
        else {
            Print-Error "$command command missing"
            $allGood = $false
        }
    }

    return $allGood
}

function Print-NextSteps {
    Write-Host @"
╔════════════════════════════════════════════════════════╗
║              Installation Complete!                    ║
╚════════════════════════════════════════════════════════╝
"@ -ForegroundColor Green
    
    Print-Info "Next steps:"
    Write-Host ""
    Write-Host "  1. Configure agent-mail CLI:"
    Write-Host "     node ~/.acp/bin/agent-mail.js --init"
    Write-Host ""
    Write-Host "  2. Verify Kimi can see the skills:"
    Write-Host "     kimi --list-skills"
    Write-Host ""
    Write-Host "  3. Start ACP and spawn an agent:"
    Write-Host "     Agents receive their onboarding instructions automatically at spawn time."
    Write-Host ""
    Write-Host "  Need help? Visit: https://docs.idealvibe.online/acp"
    Write-Host ""
}

# Main
Print-Banner

Test-Prerequisites
Backup-Existing
Install-Skills
Install-Commands

if (Test-Installation) {
    Print-NextSteps
}
else {
    Print-Error "Installation verification failed"
    Print-Info "Check backup at: $BackupDir"
    exit 1
}
