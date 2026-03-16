import { type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import type { LocalEventBus } from '../sse/localEventBus.js';

const RING_BUFFER_SIZE = 100;
const SSE_THROTTLE_MS = 1000;

interface TrackedProcess {
  contractId: number;
  agentName: string;
  hiredByName: string;
  contractSubject: string;
  child: ChildProcess;
  outputLines: string[];
  lastSseEmit: number;
}

/**
 * Tracks spawned contractor processes, captures output, handles exit/orphan detection.
 */
export class ProcessMonitor {
  private processes = new Map<number, TrackedProcess>();
  private storage: any;
  private eventBus: LocalEventBus;
  private onSlotFreed: () => void;
  private cfg: any;

  constructor(storage: any, eventBus: LocalEventBus, cfg: any, onSlotFreed: () => void) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.cfg = cfg;
    this.onSlotFreed = onSlotFreed;
  }

  /**
   * Register a spawned process for monitoring.
   * Wires up stdout/stderr capture, exit handler, and SSE events.
   */
  register(
    contractId: number,
    agentName: string,
    hiredByName: string,
    contractSubject: string,
    child: ChildProcess,
  ): void {
    const tracked: TrackedProcess = {
      contractId,
      agentName,
      hiredByName,
      contractSubject,
      child,
      outputLines: [],
      lastSseEmit: 0,
    };

    this.processes.set(contractId, tracked);

    // Emit session-started
    this.eventBus.emit({
      event: 'session-started',
      data: { contract_id: contractId, agent_name: agentName, pid: child.pid },
    });

    // Capture stdout
    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendOutput(tracked, chunk.toString(), 'stdout');
    });

    // Capture stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendOutput(tracked, chunk.toString(), 'stderr');
    });

    // Handle exit
    child.on('exit', (code: number | null) => {
      this.handleExit(tracked, code ?? 1);
    });

    // Handle error (spawn failure)
    child.on('error', (err: Error) => {
      console.error(`[ProcessMonitor] Spawn error for contract ${contractId}:`, err.message);
      this.handleExit(tracked, 1);
    });
  }

  private appendOutput(tracked: TrackedProcess, text: string, stream: 'stdout' | 'stderr'): void {
    const lines = text.split('\n').filter(l => l.length > 0);
    for (const line of lines) {
      tracked.outputLines.push(line);
      // Ring buffer: trim to max size
      if (tracked.outputLines.length > RING_BUFFER_SIZE) {
        tracked.outputLines.shift();
      }
    }

    // Throttled SSE emit
    const now = Date.now();
    if (now - tracked.lastSseEmit >= SSE_THROTTLE_MS) {
      tracked.lastSseEmit = now;
      this.eventBus.emit({
        event: 'session-output',
        data: {
          contract_id: tracked.contractId,
          line: lines[lines.length - 1] || '',
          stream,
        },
      });
    }
  }

  private async handleExit(tracked: TrackedProcess, code: number): Promise<void> {
    const now = new Date().toISOString();
    const durationMs = tracked.child.exitCode !== null
      ? Date.now() - (tracked.child as any)._startTime
      : 0;

    // Update DB
    try {
      await this.storage._query(
        `UPDATE agent_contracts
         SET exit_code = ${code},
             session_ended_at = '${now}',
             status = ${code === 0 ? "'completed'" : "'expired'"},
             completed_at = '${now}'
         WHERE id = ${tracked.contractId} AND status = 'active'`
      );
    } catch (err) {
      console.error(`[ProcessMonitor] Failed to update contract ${tracked.contractId}:`, err);
    }

    // On clean exit: send DONE reply on behalf of contractor
    if (code === 0) {
      await this.sendDoneReply(tracked);
      this.eventBus.emit({
        event: 'contractor-completed',
        data: { contract_id: tracked.contractId, contractor_agent_id: null },
      });
    } else {
      this.eventBus.emit({
        event: 'contractor-expired',
        data: { contract_id: tracked.contractId, exit_code: code },
      });
    }

    // Emit session-exited SSE
    this.eventBus.emit({
      event: 'session-exited',
      data: {
        contract_id: tracked.contractId,
        agent_name: tracked.agentName,
        exit_code: code,
        duration_seconds: Math.round(durationMs / 1000),
      },
    });

    // Cleanup
    this.processes.delete(tracked.contractId);

    // Notify session manager to drain queue
    this.onSlotFreed();
  }

  /**
   * Send DONE: reply on behalf of contractor using last 50 lines of stdout.
   */
  private async sendDoneReply(tracked: TrackedProcess): Promise<void> {
    const last50 = tracked.outputLines.slice(-50).join('\n');
    const url = `${this.cfg.vibeApiUrl}/v1/agentmail/send`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'X-Vibe-Client-Id': this.cfg.vibeClientId,
          'X-Vibe-Client-Secret': this.cfg.vibeHmacKey,
          'X-Vibe-User-Id': this.cfg.vibeUserId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from_agent: tracked.agentName,
          to: [tracked.hiredByName],
          subject: `DONE: ${tracked.contractSubject}`,
          body: last50 || '(no output captured)',
        }),
      });
    } catch (err) {
      console.error(`[ProcessMonitor] Failed to send DONE reply for contract ${tracked.contractId}:`, err);
    }
  }

  /**
   * Get output ring buffer for a contract.
   */
  getOutput(contractId: number): { lines: string[]; truncated: boolean } {
    const tracked = this.processes.get(contractId);
    if (!tracked) return { lines: [], truncated: false };
    return {
      lines: [...tracked.outputLines],
      truncated: tracked.outputLines.length >= RING_BUFFER_SIZE,
    };
  }

  /**
   * Kill a running session (for cancel). Immediate on Windows.
   */
  killSession(contractId: number): boolean {
    const tracked = this.processes.get(contractId);
    if (!tracked) return false;
    try {
      tracked.child.kill();
      return true;
    } catch {
      return false;
    }
  }

  /** Number of currently running processes. */
  get activeCount(): number {
    return this.processes.size;
  }

  /** Check if a specific contractor agent already has a running session. */
  hasRunningSession(agentName: string): boolean {
    for (const tracked of this.processes.values()) {
      if (tracked.agentName === agentName) return true;
    }
    return false;
  }

  /**
   * Orphan detection on startup. Checks DB for active contracts with session_pid set
   * and verifies the PID still exists. Marks orphans as expired.
   */
  async checkOrphans(): Promise<number> {
    let count = 0;
    try {
      const result = await this.storage._query(
        `SELECT id, session_pid FROM agent_contracts
         WHERE status = 'active' AND session_pid IS NOT NULL`
      );
      for (const row of result.rows) {
        const pid = row.session_pid;
        if (!this.isPidAlive(pid)) {
          await this.storage._query(
            `UPDATE agent_contracts
             SET status = 'expired', completed_at = NOW(),
                 session_ended_at = NOW(), cancel_reason = 'acp-restart'
             WHERE id = ${row.id}`
          );
          count++;
        }
      }
    } catch (err) {
      console.error('[ProcessMonitor] Orphan check failed:', err);
    }
    return count;
  }

  /**
   * Check if a PID is alive. On Windows, uses tasklist with PID filter
   * and verifies process name contains 'claude' (QAPert F-8: PID reuse).
   */
  private isPidAlive(pid: number): boolean {
    try {
      if (process.platform === 'win32') {
        const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8', timeout: 3000 });
        return output.toLowerCase().includes('claude');
      } else {
        process.kill(pid, 0);
        return true;
      }
    } catch {
      return false;
    }
  }
}
