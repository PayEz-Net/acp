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

/**
 * Locate the bundled `colonize-templates/` tree (the source for the skills
 * subtrees the claude/kimi items copy into the workspace). Packaged →
 * `<resources>/colonize-templates` (electron-builder extraResources, package.json
 * `to: colonize-templates`); dev → `<appPath>/colonize-templates`. Lazily
 * requires electron so importing this module (and its electron-free vitest
 * suite) stays decoupled — no electron / no bundle → null → skills are skipped
 * (markers still write; tests stay green). A packaged build with the bundle
 * MISSING is a real packaging defect, surfaced via console.warn (the
 * --acp-colonize-log captures it) but never throws — the critical markers must
 * never be broken by a skills-copy miss.
 */
function bundledTemplatesRoot(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    const packaged = !!electron.app?.isPackaged;
    const base = packaged ? process.resourcesPath : electron.app.getAppPath();
    const dir = path.join(base, 'colonize-templates');
    if (fs.existsSync(dir)) return dir;
    if (packaged) console.warn(`[colonize] bundled colonize-templates missing at ${dir}; skills not copied (packaging defect)`);
    return null;
  } catch { return null; } // electron-free (tests/dev w/o app) → skip skills, write markers
}

/** Returns true when every file in tplDir exists in destDir with identical content. */
function dirMatchesTemplate(tplDir: string, destDir: string): boolean {
  try {
    if (!fs.existsSync(tplDir)) return true;
    if (!fs.existsSync(destDir)) return false;
    for (const entry of fs.readdirSync(tplDir, { withFileTypes: true })) {
      const s = path.join(tplDir, entry.name);
      const d = path.join(destDir, entry.name);
      if (entry.isDirectory()) { if (!dirMatchesTemplate(s, d)) return false; }
      else if (!fs.existsSync(d) || fs.statSync(s).size !== fs.statSync(d).size || !fs.readFileSync(s).equals(fs.readFileSync(d))) return false;
    }
    return true;
  } catch { return false; }
}

/** Recursively copy srcDir's contents INTO destDir (best-effort, no throw).
 *  Used to stage a skills subtree under a claude/kimi item's owned top-level. */
function copyDirInto(srcDir: string, destDir: string): void {
  try {
    if (!fs.existsSync(srcDir)) return;
    for (const entry of fs.readdirSync(srcDir)) {
      const s = path.join(srcDir, entry);
      const d = path.join(destDir, entry);
      if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDirInto(s, d); }
      else { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
    }
  } catch (e) { console.warn(`[colonize] skills copy ${srcDir} -> ${destDir} partial/failed (${e instanceof Error ? e.message : String(e)})`); }
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

## Mail discipline

When you send or reply to mail (or standup), follow the **Mail discipline** norm in the agent-mail skill: glance, don't ack — reply only when you have new info, an answer to a direct question asked of you, a real blocker, a correction that changes what someone does, or a disagreement. Silence is the default; a reply is the exception.
`;
}

/** `.claude/` — settings marker + commands/report-as-<agent>.md (WO#25). */
const claudeItem: ColonizationItem = {
  id: 'claude',
  critical: true,
  check: (root, ctx) => {
    const base = path.join(root, '.claude');
    if (!nonEmptyFile(path.join(base, 'settings.json'))) return false;
    const agentsOk = ctx.agents.every((a) => {
      const f = path.join(base, 'commands', `report-${a.toLowerCase()}.md`);
      if (!nonEmptyFile(f)) return false;
      try { return fs.readFileSync(f, 'utf8').includes('127.0.0.1:3001'); }
      catch { return false; }
    });
    if (!agentsOk) return false;
    const tpl = bundledTemplatesRoot();
    if (!tpl) return true;
    return dirMatchesTemplate(path.join(tpl, '.claude', 'skills'), path.join(base, 'skills'));
  },
  materialize: (stage, ctx) => {
    const base = path.join(stage, '.claude');
    writeFile(path.join(base, 'settings.json'),
      JSON.stringify({ colonizedBy: 'idealvibe-payez-acp', schema: 1 }, null, 2) + '\n');
    for (const a of ctx.agents) {
      writeFile(path.join(base, 'commands', `report-${a.toLowerCase()}.md`),
        reportCommandContent(a));
    }
    // Claude-runtime skills: copy the bundled .claude/skills/* into the
    // workspace under this item's owned `.claude` top-level (so the engine's
    // atomic per-top-level swap covers them — disjoint-ownership preserved).
    // best-effort; never breaks the critical markers above.
    const tpl = bundledTemplatesRoot();
    if (tpl) copyDirInto(path.join(tpl, '.claude', 'skills'), path.join(base, 'skills'));
  },
};

/** `.kimi/` — provider scaffold. */
const kimiItem: ColonizationItem = {
  id: 'kimi',
  critical: false,
  check: (root) => {
    if (!nonEmptyFile(path.join(root, '.kimi', 'kimi.json'))) return false;
    const tpl = bundledTemplatesRoot();
    if (!tpl) return true;
    return dirMatchesTemplate(path.join(tpl, '.kimi', 'skills'), path.join(root, '.kimi', 'skills'));
  },
  materialize: (stage) => {
    writeFile(path.join(stage, '.kimi', 'kimi.json'),
      JSON.stringify({ colonizedBy: 'idealvibe-payez-acp', schema: 1 }, null, 2) + '\n');
    // Kimi-runtime skills: copy the bundled .kimi/skills/* into the workspace
    // under this item's owned `.kimi` top-level. best-effort; never breaks the
    // critical marker above. (Pairs with the claude item's .claude/skills.)
    const tpl = bundledTemplatesRoot();
    if (tpl) copyDirInto(path.join(tpl, '.kimi', 'skills'), path.join(stage, '.kimi', 'skills'));
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
