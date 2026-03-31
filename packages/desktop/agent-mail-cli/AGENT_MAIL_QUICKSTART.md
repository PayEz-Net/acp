# Shared Agent Mail Script - Quick Start

**Location:** `E:\Repos\Agents\_sharedAgentMailScriptsEnterpriseAuth\agent-mail.js`

## Commands

### Check Inbox
```powershell
node "E:/Repos/Agents/_sharedAgentMailScriptsEnterpriseAuth/agent-mail.js" --agent <YourAgent> --prod inbox
```

### Read a Message
```powershell
node "E:/Repos/Agents/_sharedAgentMailScriptsEnterpriseAuth/agent-mail.js" --agent <YourAgent> --prod read <message_id>
```

### Send a Message (File Body - Recommended)
```powershell
Set-Content -Path msg.txt -Value "Your message here"
node "E:/Repos/Agents/_sharedAgentMailScriptsEnterpriseAuth/agent-mail.js" --agent <YourAgent> --prod send <ToAgent> "Subject Here" --body-file msg.txt
```

### Send a Message (Inline Body - Simple Messages)
```powershell
node "E:/Repos/Agents/_sharedAgentMailScriptsEnterpriseAuth/agent-mail.js" --agent <YourAgent> --prod send <ToAgent> "Subject" --body "Short message"
```

### List All Agents
```powershell
node "E:/Repos/Agents/_sharedAgentMailScriptsEnterpriseAuth/agent-mail.js" --agent <YourAgent> --prod agents
```

## Required Flags

| Flag | Description |
|------|-------------|
| `--agent <name>` | Your agent name (e.g., BAPert, DotNetPert, NextPert, QAPert) |
| `--prod` | Use production API (api.idealvibe.online) |
| `--test` | Use test API (localhost or `VIBESQL_URL`) |

## Send Options

| Flag | Description |
|------|-------------|
| `--body-file <path>` | Read message body from file (avoids PowerShell escape issues) |
| `--body <text>` | Inline message body (for simple, short messages) |

## Examples

```powershell
# BAPert checks inbox
node "E:/Repos/Agents/_sharedAgentMailScriptsEnterpriseAuth/agent-mail.js" --agent BAPert --prod inbox

# DotNetPert reads message 344
node "E:/Repos/Agents/_sharedAgentMailScriptsEnterpriseAuth/agent-mail.js" --agent DotNetPert --prod read 344

# NextPert sends to QAPert
node "E:/Repos/Agents/_sharedAgentMailScriptsEnterpriseAuth/agent-mail.js" --agent NextPert --prod send QAPert "Build Ready" --body "Tests passed, ready for QA"

# QAPert lists team
node "E:/Repos/Agents/_sharedAgentMailScriptsEnterpriseAuth/agent-mail.js" --agent QAPert --prod agents
```

## Tips

- **Use `--body-file` for multi-line messages** - avoids all PowerShell escaping pain
- **Use forward slashes** in paths when calling from PowerShell: `E:/Repos/...` not `E:\Repos\...`
- **Quote the script path** to handle spaces safely
