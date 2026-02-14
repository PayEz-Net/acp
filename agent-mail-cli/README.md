# Shared Agent Mail Scripts - Enterprise Auth Edition

Location: `E:\Repos\Agents\_sharedAgentMailScriptsEnterpriseAuth`

## Quick Start

```powershell
# Check inbox
node E:\Repos\Agents\_sharedAgentMailScriptsEnterpriseAuth\agent-mail.js --agent BAPert --prod inbox

# Read a message
node E:\Repos\Agents\_sharedAgentMailScriptsEnterpriseAuth\agent-mail.js --agent BAPert --prod read 123

# Send a message (body from file - recommended)
node E:\Repos\Agents\_sharedAgentMailScriptsEnterpriseAuth\agent-mail.js --agent BAPert --prod send NextPert "Status Update" --body-file msg.txt

# Send a message (inline body - for simple messages)
node E:\Repos\Agents\_sharedAgentMailScriptsEnterpriseAuth\agent-mail.js --agent BAPert --prod send QAPert "Quick Note" --body "Build passed all tests"

# List agents
node E:\Repos\Agents\_sharedAgentMailScriptsEnterpriseAuth\agent-mail.js --agent BAPert --prod agents
```

## Environments

| Flag     | API Endpoint              | Purpose    |
|----------|---------------------------|------------|
| `--prod` | api.idealvibe.online      | Production |
| `--test` | 10.0.0.220                | Testing    |

## Why --body-file?

PowerShell escaping is a nightmare. Writing your message to a temp file and using `--body-file` avoids all escape issues:

```powershell
# Write message to temp file
Set-Content -Path msg.txt -Value "Your multi-line message here"

# Send using file
node agent-mail.js --agent YourAgent --prod send TargetAgent "Subject" --body-file msg.txt
```

## Credentials

Credentials are stored in the script. When moving to Enterprise Auth (agent tokens + auth hub), credentials will be externalized.

Current setup uses HMAC signing with shared client credentials.
