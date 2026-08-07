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
  /** Recent user prompts preserved before a runtime restart. When provided,
   *  the agent is reminded of the in-flight mission so the user doesn't have
   *  to restate context from scratch. */
  recentContext?: string[];
}

const DEFAULT_API_URL = process.env.ACP_API_URL || 'http://127.0.0.1:3001';

/** `2026-08-07 11:50` in local time, for the session label. */
function sessionLabelStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
  const readAllEndpoint = `${apiUrl}/v1/mail/inbox/${encodeURIComponent(agentName)}/read-all`;

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

  const recentContext = opts.recentContext?.filter((p) => p.trim()).slice(-6) ?? [];
  const hasContext = recentContext.length > 0;
  const contextSection = hasContext
    ? `## Restart context

The ACP runtime was restarted while you were working. The following recent user prompts are preserved so the mission is not lost. Read them, but do NOT act on them yet.

${recentContext.map((p, i) => `${i + 1}. ${p.trim()}`).join('\n')}`
    : '';

  const toolBan = hasProfile
    ? `## Tool discipline

Your profile and mail status are already provided above. Do NOT run any additional tools, shell commands, curl calls, mail checks, or API requests during this first turn. ${hasContext ? 'You may briefly acknowledge the restart context after the ready message, then stop.' : 'Just output the ready message and stop.'} Wait for the next user message before doing any work.`
    : `## Tool discipline

Run ONLY the curl command(s) above to load your identity (and optionally check mail). Once you have the real data, output the ready message and stop. ${hasContext ? 'You may briefly acknowledge the restart context after the ready message, then stop.' : ''} Do NOT run any other tools during this first turn. Wait for the next user message before doing any work.`;

  // Jon 2026-08-07: the first line doubles as the session's human-readable
  // NAME. Kimi derives the session title from the first prompt (raw
  // truncation today), so a leading label makes the session identifiable in
  // the kimi picker for an emergency manual resume — fresh-session-at-launch
  // is the policy, and the previous session stays on disk as the escape
  // hatch. Keep this line FIRST; do not move it below the identity header.
  return `[ACP-${agentName} — ${sessionLabelStamp()}]

${identityHeader}

${profileSection}

${mailSection}

${contextSection}

## Mail discipline

You are **${agentName}**. Mail sent to you is addressed to **your identity**, not to the human user. Your agent teammates (e.g., NextPert, BAPert, DotNetPert, QAPert) send you mail to collaborate. You are responsible for reading it and acting on it as ${agentName}.

Read each mail message when you deem it appropriate. You may skip or defer glancing at a message if you are busy and it is clearly just an ack or noise, but do not ignore actionable mail from teammates.

Use this command to fetch your inbox:

\`\`\`bash
curl -s "${mailEndpoint}" -H "X-ACP-Agent: ${agentName}"
\`\`\`

When a session ends or you are done for the day, mark all your mail as read so the next business day starts fresh:

\`\`\`bash
curl -s -X POST "${readAllEndpoint}" -H "X-ACP-Agent: ${agentName}"
\`\`\`

A user-turn line that starts with \`[ACP Mail]\` is a system notification that mail just arrived for you — not a human chatting, and not noise. It usually carries the message body inline: treat it as an instruction and act on actionable messages immediately (the curl command above is there when you need the full thread), without waiting for the human to tell you.

When you send or reply to mail (or standup), follow the **Mail discipline** norm in the agent-mail skill: glance, don't ack — reply only when you have new info, an answer to a direct question asked of you, a real blocker, a correction that changes what someone does, or a disagreement. Silence is the default; a reply is the exception.

## Ready

Say exactly:
\`\`\`
${readyMessage}
\`\`\`

${toolBan}

## Instruction discipline

- The user's most recent message is the highest-priority instruction. If it asks a direct question, answer it directly and concisely first; do not bury the answer inside task output.
- If the human messages you while you are mid-task, answer them FIRST — briefly, in text, before your next tool call — then continue the task. The human outranks mail and any in-flight work; a busy episode is never a reason to leave the human on read.
- If the user asks for a specific format (e.g., "yes or no", "just the facts", "stop editing"), match that format exactly.
- Before reading or editing a file, state which file you are touching. If the user asks "which file are you working on", answer with the path first.
- When the user corrects you, apply the correction and do not repeat the previous incorrect output verbatim.
- Do not resume an earlier task unless the user explicitly asks you to continue it.

## Platform errors

If a mail or profile API call ever returns an error containing \`SESSION_INACTIVE\` or "Session is not active", that is a transient mail-platform hiccup about session-registration data upstream — it is NEVER about you. Your session is live. Retry the call after ~30 seconds and keep responding normally; never go silent or stop working because of it.

## Project instructions

The ACP runtime starts in a shared parent directory, so project-specific instructions are NOT loaded automatically. Before you start work in a repository, read its \`AGENTS.md\` (and \`.kimi-code/AGENTS.md\`) from that repository's root and follow its rules. If the user points you at a path, treat the directory containing that path as the project root for instruction lookup.
`;
}

/**
 * Minimal fallback used when no richer data is available and we just need to
 * avoid a bare "report as" kickoff. Tells the agent how to onboard itself.
 */
export function buildMinimalBootPrompt(agentName: string, apiUrl?: string): string {
  return buildAgentBootPrompt(agentName, { apiUrl });
}

export interface ResumeNudgeOptions {
  /** Pre-fetched unread mail count. When provided, the agent reports it
   *  without making a tool call on the wake-up turn. */
  unreadCount?: number | null;
  /** ACP API base URL. */
  apiUrl?: string;
}

/**
 * Lightweight wake-up prompt sent when the app relaunches and reattaches to a
 * previous session via session/resume. Kimi replays no history on resume and
 * the renderer boots blank, so without a nudge the agent sits silent and
 * never visibly comes online. This is NOT the full boot prompt: the resumed
 * session already carries identity and conversation history, so re-onboarding
 * would duplicate it. The agent only confirms it is back, reports unread
 * mail, and waits.
 */
export function buildAgentResumeNudge(agentName: string, opts: ResumeNudgeOptions = {}): string {
  const unreadCount = typeof opts.unreadCount === 'number' ? opts.unreadCount : null;

  const mailSection = unreadCount !== null
    ? `You have **${unreadCount}** unread message${unreadCount === 1 ? '' : 's'}.`
    : `Your unread count could not be pre-fetched. Check your inbox at your next natural pause (not this turn) using your usual mail command.`;

  const readyMessage = unreadCount !== null
    ? `${agentName} back (session resumed). ${unreadCount} unread message${unreadCount === 1 ? '' : 's'}. What's the mission?`
    : `${agentName} back (session resumed). What's the mission?`;

  return `You are **${agentName}**, resumed after an ACP desktop app restart.

Your previous session was reattached with your full conversation history intact — you are already fully onboarded. Do NOT re-run onboarding, do NOT re-fetch your profile, and do NOT restate your identity.

## Mail

${mailSection}

A user-turn line that starts with \`[ACP Mail]\` is a system notification that mail just arrived for you — it usually carries the message body inline; act on actionable messages immediately. When one arrives, it overrides the wait-for-the-next-user-message rule below.

## Platform errors

If your conversation history contains an error like \`SESSION_INACTIVE\` or "Session is not active", that was a transient mail-platform hiccup — it was NEVER about you. Your session is live right now. Disregard it and respond normally; never go silent because of it.

## Ready

Say exactly:
\`\`\`
${readyMessage}
\`\`\`

## Tool discipline

Do NOT run any tools, shell commands, curl calls, mail checks, or API requests during this turn. Just output the ready message and stop. Wait for the next user message before doing any work.
`;
}
