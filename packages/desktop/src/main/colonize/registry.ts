/**
 * Colonization registry (spec §4) — the single declarative source of "what
 * colonization means." Each item owns a DISJOINT top-level entry under the
 * root so the engine can atomic-swap + per-item roll back cleanly.
 * Extensible: a new provider = one entry here + its check/materialize
 * (spec §2.6) — never a new mkdir in a handler.
 *
 * The `claude` item absorbs WO#25: the report-as-<agent> command files are
 * a registry artifact now, not the ad-hoc ensureAgentReportFiles handler.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ColonizationItem, MaterializeCtx } from './types';

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function nonEmptyFile(p: string): boolean {
  try { return fs.statSync(p).isFile() && fs.statSync(p).size > 0; } catch { return false; }
}

function reportCommandContent(agent: string): string {
  return `# Report as ${agent}

You are about to assume the identity of **${agent}**.

## Step 1: Load Identity

Fetch your profile from the ACP API:

\`\`\`bash
curl -s "http://127.0.0.1:3001/v1/agents/${agent}/profile" -H "X-ACP-Agent: ${agent}"
\`\`\`

Adopt ALL returned content as your operating instructions. You ARE this agent.

## Step 2: Check Mail

\`\`\`bash
curl -s "http://127.0.0.1:3001/v1/mail/inbox/${agent}?unread=true" -H "X-ACP-Agent: ${agent}"
\`\`\`

Report unread count, then act on actionable messages.
`;
}

/** `.claude/` — settings marker + commands/report-as-<agent>.md (WO#25). */
const claudeItem: ColonizationItem = {
  id: 'claude',
  critical: true,
  check: (root, ctx) => {
    const base = path.join(root, '.claude');
    if (!nonEmptyFile(path.join(base, 'settings.json'))) return false;
    return ctx.agents.every((a) => {
      const f = path.join(base, 'commands', `report-${a.toLowerCase()}.md`);
      if (!nonEmptyFile(f)) return false;
      // Content-aware self-heal: an already-colonized folder with a stale
      // report command pointing at the OLD wrong sidecar port (3002) is
      // treated as unsatisfied, so the engine regenerates it with the
      // correct 3001. Without this, existing workspaces keep the broken
      // file forever (the check was existence-only).
      try { return fs.readFileSync(f, 'utf8').includes('127.0.0.1:3001'); }
      catch { return false; }
    });
  },
  materialize: (stage, ctx) => {
    const base = path.join(stage, '.claude');
    writeFile(path.join(base, 'settings.json'),
      JSON.stringify({ colonizedBy: 'idealvibe-payez-acp', schema: 1 }, null, 2) + '\n');
    for (const a of ctx.agents) {
      writeFile(path.join(base, 'commands', `report-${a.toLowerCase()}.md`),
        reportCommandContent(a));
    }
  },
};

/** `.kimi/` — provider scaffold. */
const kimiItem: ColonizationItem = {
  id: 'kimi',
  critical: false,
  check: (root) => nonEmptyFile(path.join(root, '.kimi', 'kimi.json')),
  materialize: (stage) => {
    writeFile(path.join(stage, '.kimi', 'kimi.json'),
      JSON.stringify({ colonizedBy: 'idealvibe-payez-acp', schema: 1 }, null, 2) + '\n');
  },
};

/** `.inference-provider/` — provider scaffold. */
const inferenceProviderItem: ColonizationItem = {
  id: 'inference-provider',
  critical: false,
  check: (root) => nonEmptyFile(path.join(root, '.inference-provider', 'config.json')),
  materialize: (stage) => {
    writeFile(path.join(stage, '.inference-provider', 'config.json'),
      JSON.stringify({ colonizedBy: 'idealvibe-payez-acp', schema: 1 }, null, 2) + '\n');
  },
};

/** `.acp/` — agent bootstrap marker (discrete top-level, no overlap). */
const agentBootstrapItem: ColonizationItem = {
  id: 'agent-bootstrap',
  critical: true,
  check: (root) => nonEmptyFile(path.join(root, '.acp', 'bootstrap.json')),
  materialize: (stage) => {
    writeFile(path.join(stage, '.acp', 'bootstrap.json'),
      JSON.stringify({ colonizedBy: 'idealvibe-payez-acp', schema: 1, ready: true }, null, 2) + '\n');
  },
};

/** The production registry (spec §4 v1 items). Order = commit order. */
export const DEFAULT_REGISTRY: ColonizationItem[] = [
  claudeItem,
  kimiItem,
  inferenceProviderItem,
  agentBootstrapItem,
];

export type { ColonizationItem, MaterializeCtx };
