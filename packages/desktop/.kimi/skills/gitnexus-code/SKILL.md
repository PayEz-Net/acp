---
name: gitnexus-code
description: Navigate and understand codebases using GitNexus knowledge graph. Use for 'how does X work', 'what calls this', 'show me the auth flow', 'find all usages of Y'. Examples - 'how does authentication work', 'what calls processPayment', 'show me the database layer'
---

# GitNexus Code Intelligence for Kimi

Query the GitNexus knowledge graph to understand code structure.

## Key Resources

### 1. Repo Context
```
READ gitnexus://repo/acp-stable/context
```
Shows: symbol count, staleness warning

### 2. List All Processes (Execution Flows)
```
READ gitnexus://repo/acp-stable/processes
```

### 3. Trace a Process
```
READ gitnexus://repo/acp-stable/process/ProcessName
```

## GitNexus MCP Tools

### Query - Find code by concept
```
gitnexus_query({"query": "payment processing"})
→ Returns processes and symbols grouped by flow
```

### Context - 360° view of a symbol
```
gitnexus_context({"name": "validateUser"})
→ Returns: callers, callees, processes it participates in
```

### Impact - Blast radius before editing
```
gitnexus_impact({"target": "validateUser", "direction": "upstream"})
→ Returns: d=1 (will break), d=2 (likely affected), d=3 (may need testing)
```

## Workflow: Understanding Code

1. Check freshness: `READ gitnexus://repo/acp-stable/context`
2. Query concept: `gitnexus_query({"query": "concept"})`
3. Deep dive: `gitnexus_context({"name": "symbolName"})`
4. Trace flow: `READ gitnexus://repo/acp-stable/process/{name}`

## Workflow: Safe Refactoring

1. Check impact: `gitnexus_impact({"target": "X", "direction": "upstream"})`
2. Review d=1 dependents (WILL BREAK)
3. Make changes
4. Verify: `gitnexus_detect_changes({"scope": "all"})`

## Critical Rule

**Always run impact analysis before editing any function/class.**
