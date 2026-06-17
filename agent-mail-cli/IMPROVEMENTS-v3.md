# Agent Mail CLI v3 - Next Batch of Improvements

## Issues Discovered in Production Use

### 1. CRITICAL: Pagination Bug - Only Shows Page 1

**Problem:**
- CLI only fetches page 1 (20 messages max)
- NextPert has 38 messages, CLI shows only 20
- `--all` flag doesn't actually fetch all pages

**Impact:**
- Users can't see all mail
- `clear` only clears first page
- Missing critical updates in backlog

**Fix Required:**
```javascript
// Current (broken): Only fetches page 1
const result = await apiCall('GET', `/v1/agentmail/inbox/${agentName}`, config);

// Fixed: Paginate through all pages
async function fetchAllMessages(agentName, config) {
  const allMessages = [];
  let page = 1;
  let hasMore = true;
  
  while (hasMore && page <= 50) { // safety cap
    const result = await apiCall('GET', 
      `/v1/agentmail/inbox/${agentName}?page=${page}&page_size=50`, config);
    const messages = result.data?.messages || [];
    allMessages.push(...messages);
    hasMore = messages.length === 50;
    page++;
  }
  return allMessages;
}
```

### 2. CRITICAL: Config File Encoding Issues

**Problem:**
- PowerShell `echo` creates UTF-16/BOM files
- CLI can't parse config with special characters
- Users get "Unexpected token" errors

**Impact:**
- Config creation fails
- CLI falls back to requiring --agent every time
- User frustration

**Fix Required:**
```javascript
// Add encoding detection and handling
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      let content = fs.readFileSync(CONFIG_PATH, 'utf8');
      // Strip BOM if present
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.substring(1);
      }
      return JSON.parse(content);
    }
  } catch (err) {
    console.error(`Warning: Could not load config: ${err.message}`);
    // Try to repair corrupted config
    try {
      fs.unlinkSync(CONFIG_PATH);
      console.log('Removed corrupted config. Run "init" to recreate.');
    } catch {}
  }
  return {};
}
```

### 3. HIGH: Batch Operations for Large Backlogs

**Problem:**
- `clear` command only marks first page as read
- Users with 38+ messages need multiple clears
- No progress indication for large operations

**Fix Required:**
```javascript
// Enhanced clear command with pagination
async function clearAllMessages(agentName, config) {
  console.log(`\nFetching all messages for ${agentName}...`);
  
  // Fetch all pages
  const allMessages = await fetchAllMessages(agentName, config);
  const unreadMessages = allMessages.filter(m => !m.read_at);
  
  if (unreadMessages.length === 0) {
    console.log('✓ No unread messages to clear.');
    return;
  }
  
  console.log(`Found ${unreadMessages.length} unread message(s). Marking as read...\n`);
  
  // Batch with progress
  let successCount = 0;
  for (let i = 0; i < unreadMessages.length; i++) {
    const m = unreadMessages[i];
    const id = m.message_id || m.id;
    const success = await markMessageRead(id, config);
    if (success) successCount++;
    
    // Progress indicator every 10 messages
    if ((i + 1) % 10 === 0 || i === unreadMessages.length - 1) {
      console.log(`  Progress: ${i + 1}/${unreadMessages.length}`);
    }
  }
  
  console.log(`\n✓ Cleared ${successCount}/${unreadMessages.length} messages`);
}
```

### 4. MEDIUM: Better Guidance for Mail Backlog

**Problem:**
- Users don't know they have unread mail
- No proactive notifications
- Sidebar shows counts but CLI doesn't warn

**Fix Required:**
```javascript
// Add status check to every command
function checkBacklogWarning(mailbox) {
  const unread = mailbox.messages?.filter(m => !m.read_at).length || 0;
  if (unread > 20) {
    console.log(`\n⚠️  WARNING: You have ${unread} unread messages!`);
    console.log(`   Run 'node agent-mail.js inbox --all' to see all.`);
    console.log(`   Run 'node agent-mail.js clear' to mark all as read.\n`);
  }
}

// Add to main switch statement
case 'status':
  await showStatus(parsed.agent, config);
  checkBacklogWarning(await fetchMailbox(parsed.agent, config));
  break;
```

### 5. MEDIUM: Cross-Agent Mail Visibility

**Problem:**
- BAPert can't easily see NextPert's mail count
- No team-wide status view
- Have to impersonate to check others

**Proposed Feature:**
```bash
# New command
node agent-mail.js team-status

# Shows:
# [BAPert]     0 unread / 20 total
# [NextPert]  38 unread / 45 total ⚠️
# [DotNetPert] 2 unread / 25 total
# [QAPert]     1 unread / 15 total
```

### 6. LOW: Command Aliases

**Problem:**
- Typing full commands is tedious
- No shorthand for common operations

**Proposed Aliases:**
```bash
node agent-mail.js i      # inbox
node agent-mail.js c      # clear
node agent-mail.js s      # status
node agent-mail.js r 123  # read 123
node agent-mail.js rl     # read-last
```

### 7. LOW: Interactive Mode

**Problem:**
- Every command requires full CLI invocation
- No persistent session

**Proposed Feature:**
```bash
node agent-mail.js interactive

# Enters REPL mode:
> inbox
> read 3785
> clear
> exit
```

## Implementation Priority

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| **P0** | Pagination bug | Medium | High - Missing messages |
| **P0** | Config encoding | Low | High - CLI unusable |
| **P1** | Batch clear | Medium | Medium - Large backlogs |
| **P1** | Backlog warnings | Low | Medium - Awareness |
| **P2** | Team status | Medium | Low - Nice to have |
| **P2** | Aliases | Low | Low - Convenience |
| **P3** | Interactive mode | High | Low - Power user feature |

## Testing Checklist

- [ ] Test with 50+ messages (verify pagination)
- [ ] Test config creation in PowerShell, bash, cmd
- [ ] Test with corrupted config file
- [ ] Test clear with 40+ unread messages
- [ ] Verify encoding with non-ASCII characters
- [ ] Test on Windows, Mac, Linux

## Migration Notes

- These fixes are backward compatible
- Existing config files will continue to work
- Pagination fix may reveal previously hidden mail
- Recommend users run `clear` after upgrade to catch up
