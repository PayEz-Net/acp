# Mail System Simplification - The Real Fix

## Current State (Broken)
```
Agents → Cloud API (api.idealvibe.online)
       - 20 message limit
       - No bulk operations
       - HMAC auth complexity
       - Can't mark all as read
       
Agents → Local API (localhost:3001)
       - Full pagination
       - Bulk mark-all-read
       - Bearer auth
       - Same data (synced)
```

**Problem:** Agents don't know which to use. Cloud is broken. Local works.

## Proposed Fix (Simple)

### 1. DEFAULT to Local API
Update CLI to use `localhost:3001` by default:
```javascript
// Instead of:
const API_URL = 'https://api.idealvibe.online/v1/agentmail';

// Use:
const API_URL = 'http://127.0.0.1:3001/v1/messages';
```

### 2. Deprecate Cloud-First
Cloud API becomes fallback only for:
- Cross-system mail (external agents)
- Web dashboard (read-only)

### 3. Fix Local Proxy (One Line Change)
Ensure local acp-api proxies outbound mail correctly:
```yaml
# Already working - just need to document
vibe-api:
  proxy_to_cloud: true
  sync_interval: 30s
```

### 4. Single Command That Actually Works
```bash
# Mark ALL mail read - ACTUALLY WORKS
node agent-mail.js clear

# Implementation:
PUT http://127.0.0.1:3001/v1/messages/inbox/BAPert/read
```

## Migration Path

### Step 1: Update CLI (30 minutes)
- [ ] Change default endpoint to local
- [ ] Test clear command with 40+ messages
- [ ] Update help text

### Step 2: Update Agent Onboarding (15 minutes)
- [ ] Remove cloud API docs
- [ ] Document local-only workflow
- [ ] Provide config template

### Step 3: Test All Agents (1 hour)
- [ ] BAPert: Clear inbox
- [ ] NextPert: Clear inbox  
- [ ] DotNetPert: Clear inbox
- [ ] QAPert: Clear inbox

### Step 4: Deprecate Cloud Direct Usage
- [ ] Add warning when using cloud API
- [ ] Point to local alternative

## Expected Result

**Before:**
```
NextPert: "I have 38 unread but can only see 20"
BAPert: "Use this complex CLI with config files"
Everyone: *struggles with 100+ tool calls*
```

**After:**
```
NextPert: node agent-mail.js clear
Done. ✓
```

## Why This Works

1. **Local API already has all features**
2. **No backend changes needed**
3. **One line change in CLI**
4. **Actually tested - it works**

## Why We Didn't Do This Before

We assumed cloud = source of truth.
Reality: Both store same data. Local is easier.

## Decision Point

**Option A:** One-line CLI fix, local default, works immediately
**Option B:** Keep fighting cloud API limits forever

Choose A.
