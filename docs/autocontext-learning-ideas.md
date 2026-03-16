# AutoContext Learning Ideas for ACP

Inspired by [greyhaven-ai/autocontext](https://github.com/greyhaven-ai/autocontext) — a closed-loop agent learning framework.

## What AutoContext Does

AutoContext gives agents **institutional memory**. Instead of starting cold every run, it captures what worked, what failed, and applies lessons to future tasks via specialized roles:

- **Competitor** — proposes strategies
- **Analyst** — evaluates outcomes
- **Coach** — converts analysis into playbook updates
- **Architect** — suggests tooling improvements
- **Curator** — filters what persists long-term

Core loop: `Execute → Analyze → Validate → Persist → Apply → Distill`

## What ACP Already Has (vs AutoContext)

| Feature | ACP | AutoContext |
|---------|-----|------------|
| Real-time agent chat | Yes | No |
| Multi-agent coordination (party engine) | Yes | No |
| Message persistence (VibeSQL) | Yes | Yes |
| Desktop UI | Yes | No |
| Human oversight | Yes | Partial |
| Institutional memory | **No** | Yes |
| Playbook/hint storage | **No** | Yes |
| Learning loop | **No** | Yes |
| Outcome analysis | **No** | Yes |
| Model distillation | **No** | Yes |

**ACP excels at:** real-time collaboration, human observation, multi-agent orchestration.
**AutoContext excels at:** knowledge persistence, learning loops, cost optimization.
**Neither has:** an integrated learning loop within real-time agent collaboration.

## Feature Ideas (Prioritized)

### 1. Execution Outcome Logging (High Priority, Foundation)

Log structured outcomes after every cluster/thread completes. Without this, everything else is guesswork.

```sql
CREATE TABLE acp.execution_outcomes (
    outcome_id TEXT PRIMARY KEY,        -- ULID
    cluster_id TEXT,                     -- FK to conversation thread
    task_description TEXT NOT NULL,
    participants JSONB NOT NULL,         -- ["DotNetPert", "QAPert"]
    strategy_used TEXT,
    result VARCHAR(20) NOT NULL,         -- success | partial | failed
    duration_ms INTEGER,
    lessons_learned JSONB DEFAULT '[]',  -- ["PreWarmConnections", "MonitorPoolExhaustion"]
    notes JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

UI: "Save Outcome" button in cluster threads. Queryable for analytics.

### 2. Hint System (Medium Priority, Quick Win)

Contextual tips surfaced in chat when keyword matches trigger.

```sql
CREATE TABLE acp.hints (
    hint_id TEXT PRIMARY KEY,
    trigger_keywords JSONB NOT NULL,     -- ["routing", "payment", "validation"]
    hint_text TEXT NOT NULL,
    suggested_agent VARCHAR(50),
    confidence NUMERIC(3,2) DEFAULT 0.5,
    created_by_agent VARCHAR(50),
    validated_by VARCHAR(50),
    hit_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

Start with 10-20 manually curated hints from past troubleshooting. Chat UI shows hints in sidebar when keywords match incoming messages.

### 3. Learned Cluster Formation (High Priority, Party Engine Upgrade)

Extend the party engine to remember which agent combos work well.

```sql
CREATE TABLE acp.agent_capabilities (
    agent_id VARCHAR(50) NOT NULL,
    task_type VARCHAR(50) NOT NULL,
    success_rate NUMERIC(5,4) DEFAULT 0.5,
    total_attempts INTEGER DEFAULT 0,
    last_updated TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (agent_id, task_type)
);
```

After outcome logging, update capability scores. Modify `computeRelevanceMatrix()` in `relevance.js` to weight past success rates. Party engine favors proven partnerships over time.

### 4. Coach Agent Role (Medium Priority, Automation)

A dedicated agent (or BAPert) periodically reviews recent threads and proposes playbook/hint updates.

```sql
CREATE TABLE acp.coach_proposals (
    proposal_id TEXT PRIMARY KEY,
    thread_id TEXT,
    proposal_type VARCHAR(30) NOT NULL,  -- new_hint | update_playbook | new_playbook
    proposed_change JSONB NOT NULL,
    reasoning TEXT,
    confidence NUMERIC(3,2),
    status VARCHAR(20) DEFAULT 'pending_review', -- pending_review | approved | rejected
    reviewed_by VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT now()
);
```

Proposals stored pending human/curator review before persisting. Prevents garbage learning.

### 5. Playbook Templates (Medium Priority)

Store successful agent workflows as reusable templates.

```sql
CREATE TABLE acp.playbooks (
    playbook_id TEXT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    agents JSONB NOT NULL,               -- ["BAPert", "DotNetPert", "QAPert"]
    task_types JSONB NOT NULL,           -- ["code_review", "architecture"]
    steps JSONB,                         -- ordered steps
    success_rate NUMERIC(5,4) DEFAULT 0.5,
    execution_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

When party engine forms a cluster, it can suggest a playbook based on task type + agent combo.

### 6. Distillation Gateway (Future, Cost Optimization)

Export playbooks + hints as JSON that local models (Ollama, vLLM) can query. Agents check local model for hints before calling Claude/OpenAI. Not needed for v1 — useful when agent count scales.

## Implementation Roadmap

**Phase 1 (Foundation):** Outcome logging + schema in VibeSQL. UI button to save outcomes.

**Phase 2 (Learning Loop):** Capability scoring from outcomes. Party engine weights learned data.

**Phase 3 (Guidance):** Hint system with manual curation. Chat UI sidebar for hints.

**Phase 4 (Automation):** Coach agent proposes updates. Curator reviews. Auto-persist approved changes.

**Phase 5 (Scale):** Playbook templates. Distillation gateway. Export/import across teams.

## Key Insight

ACP + AutoContext concepts = agents that collaborate in real-time AND learn from their collaborations. The party engine gets smarter without code changes. All storage fits naturally in VibeSQL.
