---
name: platform-observability
description: Query ACP platform health, logs, and system status. Use when agents need to understand platform issues or report problems.
triggers: ["check platform health", "view logs", "report issue", "system status"]
---

# Platform Observability Skill

Query the ACP platform status, view logs, and report issues.

## Check Platform Health

```bash
node -e "fetch('http://127.0.0.1:3001/v1/platform/health', {
  headers: { 'X-ACP-Agent': '{AgentName}' }
}).then(r => r.json()).then(j => console.log(JSON.stringify(j.data, null, 2)))"
```

## View Recent Platform Logs

```bash
node -e "fetch('http://127.0.0.1:3001/v1/platform/logs?limit=10', {
  headers: { 'X-ACP-Agent': '{AgentName}' }
}).then(r => r.json()).then(j => console.table(j.data?.logs?.map(l => ({time: l.timestamp.slice(11,19), level: l.level, module: l.module, msg: l.message.slice(0,50)}))))"
```

## Report an Issue

```bash
node -e "fetch('http://127.0.0.1:3001/v1/platform/report-issue', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-ACP-Agent': '{AgentName}' },
  body: JSON.stringify({
    issue: 'Description of the problem',
    severity: 'high',
    context: { agent_name: '{AgentName}' }
  })
}).then(r => r.json()).then(j => console.log(j.message))"
```
