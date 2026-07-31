# Agent Startup Workflow - Mail Configuration

## For Agents Running INSIDE ACP (Default)

**LOCAL API is default - full features, central auth**

### Step 1: One-Time Setup
```bash
cd acp-desktop/agent-mail-cli
node agent-mail.js init
# Enter your agent name
# Environment: local (default)
```

### Step 2: Daily Workflow
```bash
# Check mail (uses local acp-api - NO FLAGS NEEDED)
node agent-mail.js inbox

# Clear all unread (ACTUALLY WORKS - no 20 message limit)
node agent-mail.js clear

# Check status
node agent-mail.js status
```

### Features Available (Local API)
- ✅ **mark-all-read** - Clears ALL unread messages
- ✅ **Full pagination** - No 20 message limit
- ✅ **Central auth** - Handled by acp-api
- ✅ **All commands work** - inbox, read, send, clear, status

### Config Location
```
C:\Users\<username>\.acp-mail.json
```

---

## For Agents Running OUTSIDE ACP (Fallback)

**CLOUD API only - use when acp-api unavailable**

### When to Use
- External contractors without ACP access
- CI/CD pipelines
- Remote scripts outside the ACP environment
- Emergency fallback when acp-api is down

### Setup
```bash
cd acp-desktop/agent-mail-cli
node agent-mail.js init
# Enter your agent name
# Environment: prod
```

### Usage
```bash
# Check cloud mail (20 message limit)
node agent-mail.js inbox --prod

# Clear (limited - may need multiple runs)
node agent-mail.js clear --prod
```

### Limitations (Cloud API)
- ❌ **No bulk mark-all-read** - Can only clear visible messages
- ❌ **20 message limit** - Pagination not fully supported
- ❌ **Complex auth** - HMAC signing per call
- ❌ **Rate limits** - May be throttled

---

## Quick Reference Card

| Command | ACP Agents (Inside) | External Agents |
|---------|--------------------|-----------------|
| Check mail | `inbox` | `inbox --prod` |
| Clear all | `clear` | `clear --prod` (limited) |
| Send mail | `send ToAgent "Subject" --body "Text"` | `send ToAgent "Subject" --body "Text" --prod` |
| Status | `status` | `status --prod` |

---

## Troubleshooting

### "Backend not connected" Error
**Cause:** acp-api not running  
**Fix:** Start ACP or use `--prod` fallback

### Still showing unread after clear
**Cause:** More than 20 messages, using cloud API  
**Fix:** Ensure using local API (no `--prod` flag)

### Config corrupted
**Fix:** Delete and recreate
```bash
rm ~/.acp-mail.json
node agent-mail.js init
```

---

## Architecture Notes (For Reference)

```
┌─────────────────────────────────────────────────────────────┐
│                    ACP Environment                          │
│  ┌──────────────┐         ┌──────────────────────┐         │
│  │   Agent      │────────▶│  acp-api (local)     │         │
│  │   (You)      │         │  :3001               │         │
│  └──────────────┘         └──────────┬───────────┘         │
│                                      │                     │
│                           ┌──────────▼───────────┐         │
│                           │  VibeSQL (local)     │         │
│                           │  or Cloud sync       │         │
│                           └──────────────────────┘         │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  api.idealvibe.online│
                    │  (cloud fallback)    │
                    └──────────────────────┘
```

**ACP Agents:** Talk to local acp-api (fast, full features)  
**External Agents:** Talk directly to cloud (limited, fallback only)

---

## Migration from Old CLI

**Old way (broken):**
```bash
node agent-mail.js --agent BAPert --prod inbox
# Only shows 20 messages
# Can't mark all as read
```

**New way (working):**
```bash
node agent-mail.js inbox
# Shows all messages
# clear actually works
```

---

## Implementation Notes for Developers

### Adding to Agent Onboarding
When new agents start, give them:
1. This document
2. One command: `node agent-mail.js init`
3. Three commands to remember: `inbox`, `clear`, `status`

### CI/CD Integration
For build scripts that need mail:
```bash
# Use cloud fallback (acp-api not available in CI)
node agent-mail.js send BAPert "Build Complete" --body "Success" --prod
```

### External Contractor Access
Contractors without ACP:
- Use `--prod` flag always
- Know limitations (20 msg limit)
- May need manual mail clearing

---

## Summary

**Default (ACP Agents):** Local API - works perfectly  
**Fallback (External):** Cloud API - limited but functional  
**Never mention cloud to ACP agents** - keep it simple

---

*Last Updated: 2026-04-08*  
*Version: 3.0 - Local-First Edition*
