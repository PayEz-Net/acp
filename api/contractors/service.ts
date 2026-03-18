import { readFile } from 'node:fs/promises';
import type { LocalEventBus } from '../sse/localEventBus.js';

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

function parseJsonb(val: any): any {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return null; }
}

/**
 * Compute session duration in seconds.
 * If session is still running (no end time), computes from start to now.
 */
function computeDuration(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  return Math.round((end - start) / 1000);
}

/**
 * Transform a flat SQL JOIN row (camelCase) into the nested { agent, contract } shape
 * expected by the frontend. Output keys are snake_case to match wire format.
 */
function transformContractRow(row: any): { agent: any; contract: any } {
  return {
    agent: {
      id: row.contractorAgentId,
      name: row.contractorName,
      agent_type: 'contractor',
      display_name: row.contractorDisplayName || null,
      role: row.contractorRole || null,
      model: row.contractorModel || null,
      expertise_json: parseJsonb(row.contractorExpertise),
      is_active: row.status === 'active',
    },
    contract: {
      id: row.id,
      contractor_agent_id: row.contractorAgentId,
      hired_by_agent_id: row.hiredByAgentId,
      hired_by_name: row.hiredByName || null,
      contractor_name: row.contractorName,
      contract_subject: row.contractSubject || null,
      status: row.status,
      profile_source: row.profileSource || null,
      profile_snapshot: parseJsonb(row.profileSnapshot),
      timeout_hours: row.timeoutHours,
      created_at: row.createdAt,
      completed_at: row.completedAt || null,
      session_pid: row.sessionPid || null,
      session_started_at: row.sessionStartedAt || null,
      session_ended_at: row.sessionEndedAt || null,
      exit_code: row.exitCode ?? null,
      cancel_reason: row.cancelReason || null,
      session_duration_seconds: computeDuration(row.sessionStartedAt, row.sessionEndedAt),
    },
  };
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
    // Query contractor pool from VibeSQL
    const rows = await this.storage.listPoolProfiles();
    return rows.map((r: any) => ({
      name: r.name,
      description: r.description || '',
      model: r.model || 'sonnet',
      tools: Array.isArray(r.tools) ? r.tools : [],
      source: 'database' as const,
      sourcePath: r.sourcePath || '',
    }));
  }

  /**
   * Find a profile by name from the pool directories.
   */
  async findPoolProfile(name: string): Promise<{ profile: PoolProfile; content: string } | null> {
    const pool = await this.listPool();
    const match = pool.find(p => p.name === name);
    if (!match) return null;

    // If source_path exists on disk, read the full .md content for profile snapshot
    let content = `# ${match.name}\n\n${match.description}`;
    if (match.sourcePath) {
      try {
        content = await readFile(match.sourcePath, 'utf-8');
      } catch { /* file not available, use description */ }
    }

    return { profile: match, content };
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
   * List contracts with agent data. Runs on-read expiry check when fetching active or all.
   * @param status - 'active' (default), 'completed', or 'all'
   * @param onExpire - optional callback to kill running sessions for expired contracts (F-1 fix)
   */
  async listContracts(
    status: 'active' | 'completed' | 'all' = 'active',
    onExpire?: (contractId: number) => void,
  ): Promise<any[]> {
    // On-read expiry check — expire timed-out contracts (only relevant when viewing active)
    if (status === 'active' || status === 'all') {
      const expired = await this.storage.expireContracts();
      for (const c of expired) {
        this.eventBus.emit({
          event: 'contractor-expired',
          data: { contract_id: c.id, contractor_agent_id: c.contractorAgentId },
        });
        // F-1 fix: kill running session if contract had one
        if (onExpire && c.sessionPid) {
          try { onExpire(c.id); } catch { /* non-fatal */ }
        }
      }
    }

    const rows = await this.storage.listContracts(status);
    return rows.map(transformContractRow);
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

  /**
   * Cancel a contract by contract ID. Sets status to 'cancelled'.
   * Session kill deferred to Phase 2b (when sessions exist).
   */
  async cancelContract(contractId: number, reason?: string): Promise<any> {
    const contract = await this.storage.cancelContract(contractId, reason || null);
    if (!contract) return null;
    this.eventBus.emit({
      event: 'contractor-cancelled',
      data: {
        contract_id: contract.id,
        contractor_agent_id: contract.contractorAgentId,
        status: 'cancelled',
        reason: reason || null,
      },
    });
    return contract;
  }

  /**
   * DONE: auto-completion hook. Called during mail send.
   * Detects DONE: prefix in subject, matches contract by contractor + hiring agent.
   * Returns the completed contract, or null if no match.
   */
  async checkDoneAutoComplete(fromAgentName: string, subject: string, toAgentNames: string[]): Promise<any | null> {
    if (!subject.trim().match(/^done:/i)) return null;

    // Sender is the contractor. Look up their agent ID.
    const fromAgent = await this.storage.getAgentByName(fromAgentName);
    if (!fromAgent || fromAgent.agentType !== 'contractor') return null;

    // Match contract by contractor + hiring agent (TO field)
    for (const toName of toAgentNames) {
      const toAgent = await this.storage.getAgentByName(toName);
      if (!toAgent) continue;

      const contract = await this.storage.findActiveContractByContractorAndHirer(
        fromAgent.id,
        toAgent.id,
      );
      if (contract) {
        return this.completeContract(contract.id);
      }
    }

    return null; // No matching active contract — deliver mail normally
  }
}
