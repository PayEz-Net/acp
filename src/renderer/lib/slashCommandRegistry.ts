/**
 * Slash-command registry and handlers.
 *
 * Each handler receives the parsed command context and returns a result object
 * that is rendered as a system message in the current pane.
 */

import { IDP_CLIENT_APP, IDP_CLIENT_APP_HEADER } from '@shared/idp-config';
import { useAppStore } from '../stores/appStore';
import { useAgentOutputStore } from '../stores/agentOutputStore';
import { useAgentStatusStore } from '../stores/agentStatusStore';
import { useProjectStore } from '../stores/projectStore';
import { useMailStore } from '../stores/mailStore';
import { useAutonomyStore } from '../stores/autonomyStore';
import { useStandupRoundsStore } from '../stores/standupRoundsStore';
import { COMMAND_METAS } from './slashCommands';

export interface CommandResult {
  success: boolean;
  message: string;
}

interface CommandContext {
  currentAgent: string;
}

type CommandHandler = (args: string[], ctx: CommandContext) => Promise<CommandResult> | CommandResult;

const registry = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  registry.set(name.toLowerCase(), handler);
}

export async function executeCommand(
  command: string,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const handler = registry.get(command.toLowerCase());
  if (!handler) {
    return { success: false, message: `Unknown command: /${command}. Type /help.` };
  }
  try {
    return await handler(args, ctx);
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// --- Helpers -----------------------------------------------------------------

function getLifecycleSecret(): Promise<string | null> {
  return window.electronAPI.getLocalSecret();
}

async function lifecyclePost(agentName: string, action: 'spawn' | 'kill' | 'restart'): Promise<Response> {
  const secret = await getLifecycleSecret();
  return fetch(`http://127.0.0.1:3001/v1/lifecycle/agents/${encodeURIComponent(agentName)}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
  });
}

async function lifecycleStatus(agentName: string): Promise<Response> {
  const secret = await getLifecycleSecret();
  return fetch(`http://127.0.0.1:3001/v1/lifecycle/agents/${encodeURIComponent(agentName)}/status`, {
    method: 'GET',
    headers: {
      [IDP_CLIENT_APP_HEADER]: IDP_CLIENT_APP,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
  });
}

function findAgent(name: string) {
  return useAppStore.getState().agents.find((a) => a.name === name);
}

function formatStatus(agentName: string): string {
  const status = useAgentStatusStore.getState().getStatus(agentName);
  const agent = findAgent(agentName);
  const lines = [`Status for ${agentName}:`];
  if (agent) lines.push(`  State: ${agent.status}`);
  if (status.provider) lines.push(`  Provider: ${status.provider}`);
  if (status.model) lines.push(`  Model: ${status.model}`);
  if (status.cwd) lines.push(`  CWD: ${status.cwd}`);
  if (status.contextUsage != null) lines.push(`  Context: ${status.contextUsage}%`);
  if (status.tokenUsed != null && status.tokenMax != null) {
    lines.push(`  Tokens: ${status.tokenUsed} / ${status.tokenMax}`);
  }
  if (status.composing) {
    lines.push(`  Composing: ${status.composing.duration} · ${status.composing.tokens}t`);
  }
  return lines.join('\n');
}

// --- Command handlers --------------------------------------------------------

registerCommand('help', (args) => {
  if (args.length === 0) {
    const list = COMMAND_METAS.map((c) => `/${c.name} — ${c.description}`).join('\n');
    return { success: true, message: `Available commands:\n${list}` };
  }
  const name = args[0].toLowerCase();
  const meta = COMMAND_METAS.find((c) => c.name === name);
  if (!meta) return { success: false, message: `No help for /${name}. Type /help.` };
  return { success: true, message: `${meta.usage}\n${meta.description}` };
});

registerCommand('clear', (args, ctx) => {
  const target = args[0];
  if (target === 'all') {
    useAgentOutputStore.getState().clear();
    return { success: true, message: 'Cleared all terminal output.' };
  }
  if (target) {
    useAgentOutputStore.getState().clear(target);
    return { success: true, message: `Cleared output for ${target}.` };
  }
  useAgentOutputStore.getState().clear(ctx.currentAgent);
  return { success: true, message: `Cleared output for ${ctx.currentAgent}.` };
});

registerCommand('layout', (args) => {
  const mode = args[0]?.toLowerCase();
  if (!mode || !['grid', 'focus-left', 'focus-right', 'tabs'].includes(mode)) {
    return { success: false, message: 'Usage: /layout grid|focus-left|focus-right|tabs' };
  }
  useAppStore.getState().setLayout(mode as 'grid' | 'focus-left' | 'focus-right' | 'tabs');
  return { success: true, message: `Layout set to ${mode}.` };
});

registerCommand('zoom', (args) => {
  const target = args[0];
  if (!target || target.toLowerCase() === 'reset') {
    useAppStore.getState().setActiveAgent(null);
    return { success: true, message: 'Zoom reset to grid view.' };
  }
  const agent = findAgent(target);
  if (!agent) return { success: false, message: `Agent not found: ${target}` };
  useAppStore.getState().setActiveAgent(agent.id);
  useAppStore.getState().setFocusAgent(agent.name);
  return { success: true, message: `Zoomed to ${agent.name}.` };
});

registerCommand('spawn', async (_, ctx) => {
  const agent = findAgent(ctx.currentAgent);
  if (!agent) return { success: false, message: `Agent not found: ${ctx.currentAgent}` };
  const res = await lifecyclePost(agent.name, 'spawn');
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    return { success: false, message: data?.error?.message || `Spawn failed (${res.status})` };
  }
  return { success: true, message: `Spawned ${agent.name}.` };
});

registerCommand('kill', async (_, ctx) => {
  const agent = findAgent(ctx.currentAgent);
  if (!agent) return { success: false, message: `Agent not found: ${ctx.currentAgent}` };
  const res = await lifecyclePost(agent.name, 'kill');
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    return { success: false, message: data?.error?.message || `Kill failed (${res.status})` };
  }
  return { success: true, message: `Killed ${agent.name}.` };
});

registerCommand('restart', async (_, ctx) => {
  const agent = findAgent(ctx.currentAgent);
  if (!agent) return { success: false, message: `Agent not found: ${ctx.currentAgent}` };
  const res = await lifecyclePost(agent.name, 'restart');
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    return { success: false, message: data?.error?.message || `Restart failed (${res.status})` };
  }
  return { success: true, message: `Restarted ${agent.name}.` };
});

registerCommand('status', async (_, ctx) => {
  const agent = findAgent(ctx.currentAgent);
  if (!agent) return { success: false, message: `Agent not found: ${ctx.currentAgent}` };
  try {
    const res = await lifecycleStatus(agent.name);
    if (!res.ok) {
      return { success: false, message: `Status fetch failed (${res.status})` };
    }
    const data = await res.json().catch(() => null);
    if (data?.data) {
      useAgentStatusStore.getState().setStatus(agent.name, data.data);
    }
    return { success: true, message: formatStatus(agent.name) };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
});

registerCommand('mail', async (args, ctx) => {
  if (args.length < 2) {
    return { success: false, message: 'Usage: /mail <agent> "<message>"' };
  }
  const to = args[0];
  const body = args.slice(1).join(' ');
  const ok = await useMailStore.getState().sendMessage(ctx.currentAgent, to, 'Terminal message', body);
  if (!ok) return { success: false, message: `Failed to send mail to ${to}.` };
  return { success: true, message: `Mail sent to ${to}.` };
});

registerCommand('inbox', async (args, ctx) => {
  const target = args[0] || ctx.currentAgent;
  await useMailStore.getState().fetchInbox(target);
  const projectId = useProjectStore.getState().activeProject?.id;
  const key = projectId !== undefined ? `${projectId}:${target}` : target;
  const mailbox = useMailStore.getState().mailboxes[key];
  const unread = mailbox?.unreadCount ?? 0;
  return { success: true, message: `Inbox for ${target}: ${unread} unread message${unread === 1 ? '' : 's'}.` };
});

registerCommand('unattended', async (args) => {
  const action = args[0]?.toLowerCase();
  if (action === 'start') {
    const team = useProjectStore.getState().currentProjectTeam;
    const lead = team.find((m) => m.is_lead)?.agent_name ?? 'BAPert';
    const ok = await useAutonomyStore.getState().startUnattended({
      leadAgent: lead,
      pingIntervalMinutes: 5,
      maxRuntimeHours: 8,
    });
    return ok
      ? { success: true, message: 'Unattended mode started.' }
      : { success: false, message: 'Failed to start unattended mode.' };
  }
  if (action === 'stop') {
    const ok = await useAutonomyStore.getState().stopUnattended('manual');
    return ok
      ? { success: true, message: 'Unattended mode stopped.' }
      : { success: false, message: 'Failed to stop unattended mode.' };
  }
  return { success: false, message: 'Usage: /unattended start|stop' };
});

registerCommand('standup', async () => {
  const projectId = useProjectStore.getState().activeProject?.id;
  if (!projectId) {
    return { success: false, message: 'No active project to call standup.' };
  }
  const ok = await useStandupRoundsStore.getState().callStandup(projectId);
  return ok
    ? { success: true, message: 'Standup round called.' }
    : { success: false, message: 'Failed to call standup.' };
});
