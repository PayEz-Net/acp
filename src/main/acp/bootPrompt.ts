/**
 * Code-generated agent boot prompt.
 *
 * Replaces the per-agent `.claude/commands/report-<agent>.md` files with a
 * single data-driven onboarding instruction injected into the agent's context
 * at spawn time. The agent only needs to know its name; the rest is generated
 * from code every time.
 */

export interface BootPromptOptions {
  /** Agent display name/role if known. */
  displayName?: string;
  /** Pre-fetched profile markdown from the ACP API. When provided, the agent
   *  does not need to call the API during onboarding (avoids tool-call races). */
  profile?: string | null;
  /** Pre-fetched unread mail count. When provided, the agent reports it
   *  without making an onboarding tool call. */
  unreadCount?: number | null;
  /** ACP API base URL. */
  apiUrl?: string;
}

const DEFAULT_API_URL = process.env.ACP_API_URL || 'http://127.0.0.1:3001';

/**
 * Build an onboarding prompt for an agent.
 *
 * The prompt is intentionally self-contained: it tells the agent who it is,
 * how to load its canonical identity from the ACP API, and how to check mail.
 * Callers that already have the profile/unread data can pass them in so the
 * agent avoids any tool calls during its initial turn.
 */
export function buildAgentBootPrompt(agentName: string, opts: BootPromptOptions = {}): string {
  const apiUrl = opts.apiUrl || DEFAULT_API_URL;
  const profileEndpoint = `${apiUrl}/v1/agents/${encodeURIComponent(agentName)}/profile`;
  const mailEndpoint = `${apiUrl}/v1/mail/inbox/${encodeURIComponent(agentName)}?unread=true`;

  const identityHeader = opts.displayName
    ? `You are **${agentName}** (${opts.displayName}).`
    : `You are **${agentName}**.`;

  const hasProfile = opts.profile?.trim() ?? false;
  const unreadCount = typeof opts.unreadCount === 'number' ? opts.unreadCount : null;

  const profileSection = hasProfile
    ? `## Identity

${opts.profile!.trim()}`
    : `## Step 1: Load Identity (REQUIRED)

You MUST fetch your canonical profile before saying you are ready. Run:

\`\`\`bash
curl -s "${profileEndpoint}" -H "X-ACP-Agent: ${agentName}"
\`\`\`

Adopt ALL returned content as your operating instructions. You ARE this agent. Do NOT invent a role or pretend to be a generic assistant.`;

  const mailSection = unreadCount !== null
    ? `## Mail

You have **${unreadCount}** unread message${unreadCount === 1 ? '' : 's'}.`
    : `## Step 2: Check Mail

\`\`\`bash
curl -s "${mailEndpoint}" -H "X-ACP-Agent: ${agentName}"
\`\`\`

Report the unread count, then act on actionable messages.

**You MAY run the curl command above to check mail.**`;

  const readyMessage = unreadCount !== null
    ? `${agentName} ready. ${unreadCount} unread message${unreadCount === 1 ? '' : 's'}. What's the mission?`
    : `${agentName} ready. What's the mission?`;

  const toolBan = hasProfile
    ? `## Tool discipline

Your profile and mail status are already provided above. Do NOT run any additional tools, shell commands, curl calls, mail checks, or API requests during this first turn. Just output the ready message and stop. Wait for the next user message before doing any work.`
    : `## Tool discipline

Run ONLY the curl command(s) above to load your identity (and optionally check mail). Once you have the real data, output the ready message and stop. Do NOT run any other tools during this first turn. Wait for the next user message before doing any work.`;

  return `${identityHeader}

${profileSection}

${mailSection}

## Mail discipline

When you send or reply to mail (or standup), follow the **Mail discipline** norm in the agent-mail skill: glance, don't ack — reply only when you have new info, an answer to a direct question asked of you, a real blocker, a correction that changes what someone does, or a disagreement. Silence is the default; a reply is the exception.

## Ready

Say exactly:
\`\`\`
${readyMessage}
\`\`\`

${toolBan}
`;
}

/**
 * Minimal fallback used when no richer data is available and we just need to
 * avoid a bare "report as" kickoff. Tells the agent how to onboard itself.
 */
export function buildMinimalBootPrompt(agentName: string, apiUrl?: string): string {
  return buildAgentBootPrompt(agentName, { apiUrl });
}
