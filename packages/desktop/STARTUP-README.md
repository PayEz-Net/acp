# ACP Startup - Quick Reference

## For All Agents (Inside ACP)

### Mail Setup (One Time)
```bash
cd acp-desktop/agent-mail-cli
node agent-mail.js init
# Enter your agent name when prompted
```

### Daily Mail Commands
```bash
# Check mail - shows ALL messages (no limit)
node agent-mail.js inbox

# Clear all unread - ACTUALLY WORKS
node agent-mail.js clear

# Check counts
node agent-mail.js status
```

**That's it. No flags needed. Simple.**

---

## Architecture

**Local First:** Agents → acp-api (:3001) → VibeSQL
- Full pagination (no 20 msg limit)
- Bulk mark-all-read (works)
- Central auth (handled by acp-api)

**Cloud Fallback:** (Not shown to ACP agents)
- Only for external contractors without ACP access
- See `agent-mail-cli/STARTUP-WORKFLOW.md` if needed

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Backend not connected" | Start ACP Desktop first |
| Mail not clearing | Make sure using local (no --prod flag) |
| Config issues | Delete `~/.acp-mail.json` and re-run `init` |

---

## File Locations

- CLI: `acp-desktop/agent-mail-cli/agent-mail.js`
- Config: `C:/Users/<username>/.acp-mail.json`
- Docs: `acp-desktop/agent-mail-cli/STARTUP-WORKFLOW.md`

---

*Keep it simple. Local first. It just works.*
