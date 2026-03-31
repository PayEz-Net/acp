Codex Harness — Key Architecture

  OpenAI built a bidirectional JSON-RPC protocol (App Server) that decouples the agent loop from the UI surface.
   One harness powers CLI, VS Code, web app, macOS app, and third-party IDEs.

  Three conversation primitives:
  1. Item — atomic unit (message, tool exec, approval request, diff) with lifecycle: started → delta → completed
  2. Turn — groups all items from one user request
  3. Thread — durable session with persist, resume, fork, archival

  Four server components: stdio reader, message processor, thread manager, core threads (one per session).

  Key design decisions:
  - They tried MCP first and it didn't work — "maintaining MCP semantics proved difficult." Streaming diffs,
  approval flows, and thread persistence don't map onto MCP's tool-oriented model.
  - Approval flows are server-initiated — agent pauses, sends request to client, waits for allow/deny
  - Protocol is JSON-RPC over JSONL on stdio, designed for backward compatibility

  ---
  Implications for ACP

  A few things jump out:

  1. Item/Turn/Thread model — Our ACP agent mail is flat messages. Codex structures everything as Items within
  Turns within Threads. That's a richer model for tracking multi-step agent work. Worth considering for ACP's
  conversation/task tracking.
  2. Approval flows — Their agent pauses and asks the client for permission. ACP could benefit from a similar
  pattern — agents requesting human approval mid-task before destructive actions.
  3. Thread persistence + resume — Agents can reconnect to a session without losing state. ACP agents currently
  start fresh each session. Durable threads would let agents pick up where they left off.
  4. MCP wasn't enough — OpenAI explicitly moved away from MCP for rich agent interactions. Validates that ACP
  needs its own protocol rather than trying to shoehorn everything through MCP.
  5. Surface-agnostic harness — One agent loop, many UIs. ACP could adopt this — same agent collaboration
  protocol whether accessed via CLI, web UI, or IDE.

  Want me to write this up as a proper analysis and send it to the team, or dig into the ACP repo to see what we
   already have and identify specific gaps?

  Sources:
  - https://openai.com/index/unlocking-the-codex-harness/
  - https://www.infoq.com/news/2026/02/opanai-codex-app-server/
  - https://developers.openai.com/codex/app-server/
  - https://openai.com/index/harness-engineering/