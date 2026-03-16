import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalEventBus } from '../sse/localEventBus.js';

// Contractor pool directories (custom takes precedence)
const CUSTOM_POOL_DIR = 'E:/Repos/Agents/contractors';
const BUILTIN_POOL_DIR = 'E:/Repos/everything-claude-code/agents';

interface ProfileFrontmatter {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
}

interface PoolProfile {
  name: string;
  description: string;
  model: string;
  tools: string[];
  source: string; // 'custom' | 'builtin'
  sourcePath: string;
}

interface ResolveResult {
  action: 'passthrough' | 'new_contract' | 'rejected';
  agent?: any;
  contract?: any;
  error?: string;
}

/**
 * Parse YAML-like frontmatter from a markdown profile file.
 * Handles the --- delimited block at the top of .md files.
 */
function parseFrontmatter(content: string): ProfileFrontmatter | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const block = match[1];
  const result: Record<string, any> = {};

  for (const line of block.split('\n')) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    let val: any = rawVal.trim();

    // Parse array values like ["Read", "Write"]
    if (val.startsWith('[') && val.endsWith(']')) {
      try {
        val = JSON.parse(val);
      } catch {
        val = val.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, ''));
      }
    }
    // Strip surrounding quotes
    if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }

    result[key] = val;
  }

  return result.name ? (result as ProfileFrontmatter) : null;
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan a pool directory for .md profiles with valid frontmatter.
 */
async function scanPoolDir(dir: string, source: 'custom' | 'builtin'): Promise<PoolProfile[]> {
  if (!(await dirExists(dir))) return [];
  const files = await readdir(dir);
  const profiles: PoolProfile[] = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm) continue;
      profiles.push({
        name: fm.name,
        description: fm.description || '',
        model: fm.model || 'sonnet',
        tools: fm.tools || [],
        source,
        sourcePath: join(dir, file),
      });
    } catch {
      // skip unreadable files
    }
  }

  return profiles;
}

export class ContractorService {
  private storage: any;
  private eventBus: LocalEventBus;

  constructor(storage: any, eventBus: LocalEventBus) {
    this.storage = storage;
    this.eventBus = eventBus;
  }

  /**
   * List all available contractor profiles from both pool directories.
   * Custom pool takes precedence (overrides built-in with same name).
   */
  async listPool(): Promise<PoolProfile[]> {
    const [customProfiles, builtinProfiles] = await Promise.all([
      scanPoolDir(CUSTOM_POOL_DIR, 'custom'),
      scanPoolDir(BUILTIN_POOL_DIR, 'builtin'),
    ]);

    // Custom overrides built-in by name
    const seen = new Set<string>();
    const merged: PoolProfile[] = [];
    for (const p of customProfiles) {
      seen.add(p.name);
      merged.push(p);
    }
    for (const p of builtinProfiles) {
      if (!seen.has(p.name)) {
        merged.push(p);
      }
    }
    return merged.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Find a profile by name from the pool directories.
   */
  async findPoolProfile(name: string): Promise<{ profile: PoolProfile; content: string } | null> {
    // Custom first
    const customPath = join(CUSTOM_POOL_DIR, `${name}.md`);
    try {
      const content = await readFile(customPath, 'utf-8');
      const fm = parseFrontmatter(content);
      if (fm) {
        return {
          profile: {
            name: fm.name,
            description: fm.description || '',
            model: fm.model || 'sonnet',
            tools: fm.tools || [],
            source: 'custom',
            sourcePath: customPath,
          },
          content,
        };
      }
    } catch { /* not found in custom pool */ }

    // Built-in fallback
    const builtinPath = join(BUILTIN_POOL_DIR, `${name}.md`);
    try {
      const content = await readFile(builtinPath, 'utf-8');
      const fm = parseFrontmatter(content);
      if (fm) {
        return {
          profile: {
            name: fm.name,
            description: fm.description || '',
            model: fm.model || 'sonnet',
            tools: fm.tools || [],
            source: 'builtin',
            sourcePath: builtinPath,
          },
          content,
        };
      }
    } catch { /* not found in built-in pool */ }

    return null;
  }

  /**
   * Resolve a mail recipient for contractor logic.
   * Called before proxying mail send to cloud.
   *
   * Returns:
   *  - passthrough: recipient is a team agent, normal delivery
   *  - new_contract: contractor resolved, contract created
   *  - rejected: max contracts exceeded
   */
  async resolveRecipient(
    fromAgentName: string,
    toAgentName: string,
    subject: string,
    timeoutHours?: number,
  ): Promise<ResolveResult> {
    // Ensure from_agent exists in local agents table
    const fromAgent = await this.storage.upsertAgent({
      name: fromAgentName,
      agentType: 'team',
    });

    // Look up recipient
    const existingAgent = await this.storage.getAgentByName(toAgentName);

    if (existingAgent && existingAgent.agentType === 'team') {
      // Team agent — normal mail delivery, no contract
      return { action: 'passthrough' };
    }

    // Check max 3 active contracts for hiring agent
    const activeCount = await this.storage.countActiveContractsByHirer(fromAgent.id);
    if (activeCount >= 3) {
      return {
        action: 'rejected',
        error: `Max 3 active contracts per agent. Complete or cancel an existing contract first. Active: ${activeCount}`,
      };
    }

    let contractorAgent = existingAgent;

    if (!contractorAgent) {
      // New contractor — check pool for profile
      const poolResult = await this.findPoolProfile(toAgentName);

      if (poolResult) {
        // Pool profile found — create agent with profile data
        contractorAgent = await this.storage.upsertAgent({
          name: toAgentName,
          displayName: poolResult.profile.name,
          role: poolResult.profile.description,
          model: poolResult.profile.model,
          expertiseJson: { tools: poolResult.profile.tools },
          agentType: 'contractor',
        });

        // Create contract with profile snapshot
        const contract = await this.storage.createContract({
          contractorAgentId: contractorAgent.id,
          hiredByAgentId: fromAgent.id,
          contractSubject: subject,
          profileSource: poolResult.profile.sourcePath,
          profileSnapshot: {
            name: poolResult.profile.name,
            description: poolResult.profile.description,
            model: poolResult.profile.model,
            tools: poolResult.profile.tools,
            source: poolResult.profile.source,
          },
          timeoutHours: timeoutHours ?? 72,
        });

        this.eventBus.emit({
          event: 'contractor-hired',
          data: {
            agent: { id: contractorAgent.id, name: toAgentName },
            contract_id: contract.id,
            hired_by: fromAgentName,
            has_profile: true,
          },
        });

        return { action: 'new_contract', agent: contractorAgent, contract };
      } else {
        // No pool profile — ad-hoc contractor (name only)
        contractorAgent = await this.storage.upsertAgent({
          name: toAgentName,
          agentType: 'contractor',
        });

        const contract = await this.storage.createContract({
          contractorAgentId: contractorAgent.id,
          hiredByAgentId: fromAgent.id,
          contractSubject: subject,
          timeoutHours: timeoutHours ?? 72,
        });

        this.eventBus.emit({
          event: 'contractor-hired',
          data: {
            agent: { id: contractorAgent.id, name: toAgentName },
            contract_id: contract.id,
            hired_by: fromAgentName,
            has_profile: false,
          },
        });

        return { action: 'new_contract', agent: contractorAgent, contract };
      }
    }

    // Existing contractor — create new contract
    const poolResult = await this.findPoolProfile(toAgentName);
    const contract = await this.storage.createContract({
      contractorAgentId: contractorAgent.id,
      hiredByAgentId: fromAgent.id,
      contractSubject: subject,
      profileSource: poolResult?.profile.sourcePath || null,
      profileSnapshot: poolResult ? {
        name: poolResult.profile.name,
        description: poolResult.profile.description,
        model: poolResult.profile.model,
        tools: poolResult.profile.tools,
        source: poolResult.profile.source,
      } : contractorAgent.expertiseJson || null,
      timeoutHours: timeoutHours ?? 72,
    });

    this.eventBus.emit({
      event: 'contractor-hired',
      data: {
        agent: { id: contractorAgent.id, name: toAgentName },
        contract_id: contract.id,
        hired_by: fromAgentName,
        has_profile: !!poolResult,
      },
    });

    return { action: 'new_contract', agent: contractorAgent, contract };
  }

  /**
   * List active contracts with agent data. Also runs on-read expiry check.
   */
  async listActive(): Promise<any[]> {
    // On-read expiry check — expire timed-out contracts
    const expired = await this.storage.expireContracts();
    for (const c of expired) {
      this.eventBus.emit({
        event: 'contractor-expired',
        data: { contract_id: c.id, contractor_agent_id: c.contractorAgentId },
      });
    }
    return this.storage.listActiveContracts();
  }

  /**
   * Mark a contract complete by contract ID.
   */
  async completeContract(contractId: number): Promise<any> {
    const contract = await this.storage.completeContract(contractId);
    if (!contract) return null;
    this.eventBus.emit({
      event: 'contractor-completed',
      data: { contract_id: contract.id, contractor_agent_id: contract.contractorAgentId },
    });
    return contract;
  }
}
