import type { LocalEventBus } from '../sse/localEventBus.js';

interface HookDeps {
  eventBus: LocalEventBus;
  storage: any; // Storage adapter
  supervisor: any; // Autonomy supervisor
}

/**
 * Lifecycle hooks — wires agent lifecycle and mail events to standup entries
 * and SSE events.
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
   * Called when an agent is spawned. Logs standup and emits the spawn-default
   * IDLE agent status (the AGENT owns working/idle via POST /v1/status).
   */
  async onAgentSpawned(agentName: string): Promise<void> {
    // Standup entry: lifecycle
    await this.addStandupEntry(agentName, 'lifecycle', `${agentName} spawned`);

    // Spawn defaults the board status to IDLE, not 'ready'/inferred-busy
    // (comprehensive-installer-v1 §4): the AGENT decides its working/idle status via
    // POST /v1/status. A freshly-spawned agent that hasn't self-reported shows idle.
    this.eventBus.emitAgentStatus({ agent: agentName, status: 'idle' });
  }

  /**
   * Called when an agent exits. Logs standup and emits agent status.
   */
  async onAgentExited(agentName: string, exitCode: number): Promise<void> {
    const reason = exitCode === 0 ? 'clean exit' : `crash (code ${exitCode})`;
    await this.addStandupEntry(agentName, 'lifecycle', `${agentName} exited: ${reason}`);

    this.eventBus.emitAgentStatus({
      agent: agentName,
      status: exitCode === 0 ? 'stopped' : 'error',
      exit_code: exitCode,
    });
  }

  /**
   * Called when mail proxy sends a message. Logs standup.
   */
  async onMailSent(fromAgent: string, subject: string, toAgents: string[]): Promise<void> {
    // Standup entry: communication
    const summary = `Sent mail to ${toAgents.join(', ')}: "${subject}"`;
    await this.addStandupEntry(fromAgent, 'communication', summary);
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
