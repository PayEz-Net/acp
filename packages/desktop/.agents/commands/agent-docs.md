# Agent Docs

Manage versioned documents for agents. Use this for specs, reports, handoffs, and any persistent content that needs version history.

## API Access

**Base URL:** `https://api.idealvibe.online/v1/agentdocs`

**Required headers on ALL requests:**
```
X-Vibe-Client-Id: $VIBE_CLIENT_ID
X-Vibe-Client-Secret: $VIBE_CLIENT_SECRET
X-Vibe-User-Id: 0
X-IDP-Client-App: acp_desktop
Content-Type: application/json
```

> Set `VIBE_CLIENT_ID` / `VIBE_CLIENT_SECRET` from your environment (prod prod-creds, dev/93 has `vibe_YOUR_CLIENT_ID`). Hardcoded credentials were removed from this doc — never paste real secrets back in.

---

## Upload a Document
```bash
curl -s -X POST "https://api.idealvibe.online/v1/agentdocs/upload" \
  -H "X-Vibe-Client-Id: $VIBE_CLIENT_ID" \
  -H "X-IDP-Client-App: acp_desktop" \
  -H "X-Vibe-Client-Secret: $VIBE_CLIENT_SECRET" \
  -H "X-Vibe-User-Id: 0" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "{YOUR_AGENT_NAME}",
    "title": "Document Title",
    "content": "Full document content (markdown)",
    "doc_type": "spec"
  }'
```

**doc_type values:** `spec`, `report`, `handoff`, `briefing`, `prd`, `brd`, `research`, `note`

---

## List Documents for an Agent
```bash
curl -s "https://api.idealvibe.online/v1/agentdocs/list/{AGENT_NAME}" \
  -H "X-Vibe-Client-Id: $VIBE_CLIENT_ID" \
  -H "X-IDP-Client-App: acp_desktop" \
  -H "X-Vibe-Client-Secret: $VIBE_CLIENT_SECRET" \
  -H "X-Vibe-User-Id: 0"
```

### Query Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `doc_type` | string | — | Filter by type (e.g., `spec`, `report`) |
| `search` | string | — | Search by title |
| `page` | int | `1` | Page number |
| `pageSize` | int | `20` | Results per page (max 100) |
| `includeDeleted` | bool | `false` | Include soft-deleted documents |

**Example:** `?doc_type=spec&search=billing`

---

## Get a Document
```bash
curl -s "https://api.idealvibe.online/v1/agentdocs/{DOCUMENT_ID}" \
  -H "X-Vibe-Client-Id: $VIBE_CLIENT_ID" \
  -H "X-IDP-Client-App: acp_desktop" \
  -H "X-Vibe-Client-Secret: $VIBE_CLIENT_SECRET" \
  -H "X-Vibe-User-Id: 0"
```

Get a specific version: `?version=2`

---

## Update a Document (creates new version)
```bash
curl -s -X PUT "https://api.idealvibe.online/v1/agentdocs/{DOCUMENT_ID}" \
  -H "X-Vibe-Client-Id: $VIBE_CLIENT_ID" \
  -H "X-IDP-Client-App: acp_desktop" \
  -H "X-Vibe-Client-Secret: $VIBE_CLIENT_SECRET" \
  -H "X-Vibe-User-Id: 0" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Updated content — previous version is preserved",
    "title": "Optional new title"
  }'
```
Every update creates a new version. Previous versions are never lost.

---

## Delete a Document (soft delete)
```bash
curl -s -X DELETE "https://api.idealvibe.online/v1/agentdocs/{DOCUMENT_ID}" \
  -H "X-Vibe-Client-Id: $VIBE_CLIENT_ID" \
  -H "X-IDP-Client-App: acp_desktop" \
  -H "X-Vibe-Client-Secret: $VIBE_CLIENT_SECRET" \
  -H "X-Vibe-User-Id: 0"
```

---

## Get Version History
```bash
curl -s "https://api.idealvibe.online/v1/agentdocs/{DOCUMENT_ID}/history" \
  -H "X-Vibe-Client-Id: $VIBE_CLIENT_ID" \
  -H "X-IDP-Client-App: acp_desktop" \
  -H "X-Vibe-Client-Secret: $VIBE_CLIENT_SECRET" \
  -H "X-Vibe-User-Id: 0"
```

---

## Usage Guidelines

- Store specs, PRDs, handoffs, and any artifact that needs to survive across sessions
- Use `doc_type` to organize: `spec` for technical specs, `handoff` for session handoffs, etc.
- Updates are versioned automatically — safe to iterate on a document over time
- Search by title with `?search=` to find documents quickly
