# Agent Docs

Manage versioned documents for agents — specs, reports, handoffs, and any
persistent content that needs to survive across sessions.

## API Access

Go through the local ACP sidecar — it authenticates over your agent session and
routes to the cloud for you. **No client secret or endpoint host to manage here.**

**Base URL:** `http://127.0.0.1:3001/v1/documents`

**Required header on ALL requests:**
```
X-ACP-Agent: {YOUR_AGENT_NAME}
```

---

## Create a Document
```bash
curl -s -X POST "http://127.0.0.1:3001/v1/documents" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Document Title",
    "content_md": "Full document content (markdown)",
    "type": "spec"
  }'
```

**type values:** `spec`, `report`, `handoff`, `briefing`, `prd`, `brd`, `research`, `note`
(Optional `project_id` scopes the doc to a project.)

---

## List Documents
```bash
curl -s "http://127.0.0.1:3001/v1/documents" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}"
```
Optionally scope to a project: `?project_id={ID}`

---

## Get a Document
```bash
curl -s "http://127.0.0.1:3001/v1/documents/{DOCUMENT_ID}" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}"
```

---

## Update a Document (creates a new version)
```bash
curl -s -X PUT "http://127.0.0.1:3001/v1/documents/{DOCUMENT_ID}" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}" \
  -H "Content-Type: application/json" \
  -d '{
    "content_md": "Updated content — previous version is preserved",
    "title": "Optional new title"
  }'
```
Every update creates a new version. Previous versions are never lost.

---

## Delete a Document (soft delete)
```bash
curl -s -X DELETE "http://127.0.0.1:3001/v1/documents/{DOCUMENT_ID}" \
  -H "X-ACP-Agent: {YOUR_AGENT_NAME}"
```

---

## Usage Guidelines

- Store specs, PRDs, handoffs, and any artifact that needs to survive across sessions.
- Use `type` to organize: `spec` for technical specs, `handoff` for session handoffs, etc.
- Updates are versioned automatically — safe to iterate on a document over time.
