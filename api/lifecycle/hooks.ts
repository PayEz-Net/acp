import type { LocalEventBus } from '../sse/localEventBus.js';

interface HookDeps {
  eventBus: LocalEventBus;
  storage: any; // Storage adapter
  supervisor: any; // Autonomy supervisor
}

/**
 * Lifecycle hooks — wires agent lifecycle, mail, and party events
 * to standup entries and SSE events.
 */
export class LifecycleHooks {
  private eventBus: LocalEventBus;
  private storage: any;
  private supervisor: any;

  constructor(deps: HookDeps) {
    this.eventBus = deps.eventBus;
    this.storage = deps.storage;
    this.supervisor = deps.supervisor;
  }

  /**
   * Called when an agent is spawned. Signals party engine and logs standup.
   */
  async onAgentSpawned(agentName: string): Promise<void> {
    // Party engine: auto-signal with zone entrance, status IDLE. The PERSISTED signal store
    // must agree with the agent-status SSE below (both idle) — the renderer rehydrates this
    // store via GET /v1/party, so persisting a non-idle/out-of-enum value (was 'available')
    // would make a never-reporting agent rehydrate as non-idle on initial-load/reconnect,
    // breaking the §4 spawn-default-idle rule on every surface but the live SSE (QA 8077).
    try {
      await this.storage.upsertSignal({
        agentId: `agent:${agentName}`,
        agentName,
        zone: 'entrance',
        status: 'idle',
        needs: [],
        offers: [],
        keywords: [],
        workingOn: null,
        positionX: 50 + Math.random() * 20 - 10,
        positionY: 50 + Math.random() * 20 - 10,
      });
    } catch {
      // Storage failure is non-fatal
    }

    // Standup entry: lifecycle
    await this.addStandupEntry(agentName, 'lifecycle', `${agentName} spawned`);

    // SSE: party + agent status. The party 'agent_joined' delta carries the honest at-rest
    // default (idle), NOT a fabricated 'available' — by-signature trust-render purge (Aurum 8081,
    // QA 8084): no non-self-report source may emit a work-status-shaped value (working/available/
    // busy). 'zone: entrance' carries the join/presence concept; status stays honest-idle.
    this.eventBus.emitPartyUpdate({
      type: 'agent_joined',
      agent: agentName,
      zone: 'entrance',
      status: 'idle',
    });
    // Spawn defaults the board status to IDLE, not 'ready'/inferred-busy
    // (comprehensive-installer-v1 §4): the AGENT decides its working/idle status via
    // POST /v1/status. A freshly-spawned agent that hasn't self-reported shows idle.
    this.eventBus.emitAgentStatus({ agent: agentName, status: 'idle' });
  }

  /**
   * Called when an agent exits. Removes party signal and logs standup.
   */
  async onAgentExited(agentName: string, exitCode: number): Promise<void> {
    // Party engine: remove signal
    try {
      await this.storage.deleteSignal(`agent:${agentName}`);
    } catch {
      // Storage failure is non-fatal
    }

    const reason = exitCode === 0 ? 'clean exit' : `crash (code ${exitCode})`;
    await this.addStandupEntry(agentName, 'lifecycle', `${agentName} exited: ${reason}`);

    this.eventBus.emitPartyUpdate({
      type: 'agent_left',
      agent: agentName,
    });
    this.eventBus.emitAgentStatus({
      agent: agentName,
      status: exitCode === 0 ? 'stopped' : 'error',
      exit_code: exitCode,
    });
  }

  /**
   * Called when mail proxy sends a message. Logs standup and updates party keywords.
   */
  async onMailSent(fromAgent: string, subject: string, toAgents: string[]): Promise<void> {
    // Standup entry: communication
    const summary = `Sent mail to ${toAgents.join(', ')}: "${subject}"`;
    await this.addStandupEntry(fromAgent, 'communication', summary);

    // Party engine: extract keywords from subject for needs/offers matching
    const keywords = subject
      .toLowerCase()
      .split(/[\s:,\-—]+/)
      .filter(w => w.length > 3)
      .slice(0, 5);

    if (keywords.length > 0) {
      try {
        const signals = await this.storage.listSignals();
        const agentSignal = signals.find((s: any) =>
          (s.agentId || s.agent_id) === `agent:${fromAgent}`
        );
        if (agentSignal) {
          await this.storage.upsertSignal({
            ...agentSignal,
            agentId: agentSignal.agentId || agentSignal.agent_id,
            agentName: agentSignal.agentName || agentSignal.agent_name,
            keywords,
            workingOn: subject.substring(0, 100),
          });
        }
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * PTY-activity inference RETIRED as the working/idle authority (comprehensive-installer-v1 §4,
   * Jon's authority rule: the AGENT decides its status via POST /v1/status). These hooks no longer
   * WRITE status — an inferred busy/idle the user can't trust is worse than an honest self-report.
   * Kept as no-ops (not deleted) so any residual PTY-activity caller can't crash; they assert
   * nothing. No silent fallback to inference: absence of a self-report defaults idle (renderer).
   */
  async onAgentBusy(_agentName: string): Promise<void> {
    // intentionally no-op — status authority is agent self-report (POST /v1/status)
  }

  async onAgentIdle(_agentName: string): Promise<void> {
    // intentionally no-op — status authority is agent self-report (POST /v1/status)
  }

  /**
   * Called when autonomy stops. Logs standup and emits SSE.
   */
  async onAutonomyStop(reason: string): Promise<void> {
    await this.addStandupEntry('system', 'autonomy_stop', `Autonomy stopped: ${reason}`);
    this.eventBus.emitAutonomyUpdate({
      type: 'stopped',
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Called when autonomy starts. Emits SSE.
   */
  async onAutonomyStart(): Promise<void> {
    await this.addStandupEntry('system', 'lifecycle', 'Autonomy started');
    this.eventBus.emitAutonomyUpdate({
      type: 'started',
      timestamp: new Date().toISOString(),
    });
  }

  private async addStandupEntry(agentName: string, type: string, summary: string): Promise<void> {
    try {
      await this.supervisor.addStandupEntry({ agentName, type, summary });
      this.eventBus.emitStandupEntry({ agent: agentName, type, summary });
    } catch {
      // Storage failure is non-fatal for hooks
    }
  }
  // updateSignalStatus() removed — it backed the PTY-activity inference (onAgentBusy/onAgentIdle),
  // retired as the status authority (comprehensive-installer-v1 §4). Status is now agent self-report
  // via POST /v1/status; no inferred-status writer remains.
}
