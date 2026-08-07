/**
 * Work-activity store (kanban 181986).
 *
 * The 2026-08-06→07 overnight stall: the team sat idle ~8h with real work on
 * the board because nobody dealt the next hand, and the platform could not see
 * it — heartbeats kept firing from brain-idle agents all night. This store
 * records the timestamp of the last WORK-BEARING authenticated call, globally
 * and per agent, so the WorkStoppageMonitor can measure silence against it.
 *
 * What counts as a work call is decided by the stamp middleware
 * (api/middleware/workActivityStamp.ts) — this module only keeps the clocks.
 */

export interface WorkActivitySnapshot {
  /** Seconds since the last work-bearing call from any agent. */
  silenceSeconds: number;
  /** ISO timestamp of the last work-bearing call from any agent. */
  lastWorkCallAt: string;
  /** ISO timestamp of each agent's last work-bearing call. */
  perAgent: Record<string, string>;
}

export class WorkActivity {
  private lastGlobal: number;
  private readonly perAgent = new Map<string, number>();

  constructor(now: number = Date.now()) {
    // Seed at boot: a freshly started hub has had no work calls YET, and
    // treating boot as the last activity gives it one threshold of grace
    // instead of reporting an instant stall-since-epoch.
    this.lastGlobal = now;
  }

  record(agentName: string, now: number = Date.now()): void {
    this.lastGlobal = now;
    this.perAgent.set(agentName, now);
  }

  snapshot(now: number = Date.now()): WorkActivitySnapshot {
    const perAgent: Record<string, string> = {};
    for (const [name, at] of this.perAgent) {
      perAgent[name] = new Date(at).toISOString();
    }
    return {
      silenceSeconds: Math.max(0, Math.floor((now - this.lastGlobal) / 1000)),
      lastWorkCallAt: new Date(this.lastGlobal).toISOString(),
      perAgent,
    };
  }
}
