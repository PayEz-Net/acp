# Agent Mail CLI v2 - Improvements Summary

## The Problem

The original `agent-mail.js` CLI was painful to use:

```bash
# BEFORE: Verbose, repetitive, error-prone
node agent-mail.js --agent BAPert --prod inbox
node agent-mail.js --agent BAPert --prod read 3684
# Mark all read? Not even possible - had to script it yourself
# Local vs Cloud? No distinction - just confusing errors
```

## The Solution

### 1. Config File Support (`~/.acp-mail.json`)

```bash
# Run once
node agent-mail.js init
# Enter agent name: BAPert
# Enter environment: prod

# Then forever after
node agent-mail.js inbox      # No --agent, no --prod needed
node agent-mail.js clear      # Mark all as read
```

### 2. New Commands

| Command | Description |
|---------|-------------|
| `init` | Interactive config setup |
| `config` | Show current config |
| `clear` | Mark ALL messages as read |
| `mark-read <id>` | Mark specific message as read |
| `read-last` | Read most recent message (auto-marks as read) |
| `status` | Show **both** CLOUD and LOCAL unread counts |

### 3. LOCAL vs CLOUD Support (`--local` flag)

```bash
# CLOUD (default) - Persistent, projects live here
node agent-mail.js inbox           # api.idealvibe.online
node agent-mail.js clear           # Mark cloud mail read

# LOCAL (--local) - Ephemeral, dev only  
node agent-mail.js inbox --local   # localhost:3001
node agent-mail.js clear --local   # Mark local mail read

# Check both
node agent-mail.js status
# [CLOUD] api.idealvibe.online: 0 unread / 20 total
# [LOCAL] localhost:3001:        0 unread / 30 total
```

### 4. API Endpoint: `POST /v1/mail/inbox/:agent/read-all`

Added to `acp-desktop/acp-api/api/routes/mailProxy.ts`:

```typescript
// Efficient bulk operation - 1 API call instead of N
POST /v1/mail/inbox/BAPert/read-all
// Response: { success: true, data: { marked: 6, total: 6, agent: "BAPert" } }
```

### 5. MailStore Enhancement

Added to `mailStore.ts`:

```typescript
export async function markAllMessagesRead(agent: string): Promise<{ success: boolean; marked?: number }>
```

## Before vs After

| Task | Before | After |
|------|--------|-------|
| Check inbox | `node agent-mail.js --agent BAPert --prod inbox` | `node agent-mail.js inbox` |
| Check LOCAL inbox | **Impossible** - different API | `node agent-mail.js inbox --local` |
| Mark all read | **Impossible** - needed custom script | `node agent-mail.js clear` |
| Mark LOCAL read | **Impossible** - needed SQL | `node agent-mail.js clear --local` |
| See both counts | **Impossible** | `node agent-mail.js status` |
| Read latest | Get ID from inbox, then `read <id>` | `node agent-mail.js read-last` |
| Setup | Type `--agent` and `--prod` every time | `node agent-mail.js init` once |

## Files Changed

1. **NEW**: `acp-desktop/agent-mail-cli/agent-mail-v2.js` → now `agent-mail.js` - Enhanced CLI
2. **MODIFIED**: `acp-desktop/acp-api/api/routes/mailProxy.ts` - Added `/inbox/:agent/read-all` endpoint
3. **MODIFIED**: `acp-desktop/src/renderer/stores/mailStore.ts` - Added `markAllMessagesRead()`

## Migration Complete

✅ Original CLI backed up to `agent-mail-legacy.js`
✅ New CLI active as `agent-mail.js`
✅ Config created at `~/.acp-mail.json`

## Future Improvements

1. **Thread operations**: `clear-thread <thread-id>`
2. **Search**: `search <query>` to find messages
3. **Reply**: `reply <id>` with auto-quote of original
4. **Archive**: `archive <id>` and `archive-all`
5. **Notification integration**: Desktop notifications for new mail
6. **Sync**: `sync` command to copy local → cloud or cloud → local
