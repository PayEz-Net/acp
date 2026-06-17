import skillCatalogJson from '../../../skills/acp-skills.json';

export interface SkillDefinition {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  path: string;
}

const catalog = skillCatalogJson as {
  name: string;
  version: string;
  description: string;
  minimumAcpVersion: string;
  skills: SkillDefinition[];
};

const skillMap = new Map<string, SkillDefinition>();
for (const skill of catalog.skills) {
  skillMap.set(skill.name, skill);
}

/** Return all skills from the static registry. */
export function getSkillCatalog(): SkillDefinition[] {
  return catalog.skills;
}

/** Lookup a single skill by its kebab-case name. */
export function getSkillByName(name: string): SkillDefinition | undefined {
  return skillMap.get(name);
}

/** Human-readable display name (falls back to name). */
export function getSkillDisplayName(name: string): string {
  return skillMap.get(name)?.name ?? name;
}

/** Deterministic color derived from skill name hash. */
export function getSkillColor(name: string): string {
  const colors = [
    'bg-blue-500/20 text-blue-400 border-blue-500/30',
    'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    'bg-amber-500/20 text-amber-400 border-amber-500/30',
    'bg-violet-500/20 text-violet-400 border-violet-500/30',
    'bg-rose-500/20 text-rose-400 border-rose-500/30',
    'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
    'bg-orange-500/20 text-orange-400 border-orange-500/30',
    'bg-pink-500/20 text-pink-400 border-pink-500/30',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}
