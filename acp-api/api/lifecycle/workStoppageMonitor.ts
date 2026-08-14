import type { Config } from '../../config.js';
import type { WorkActivity } from './workActivity.js';

/**
 * Work-stoppage detection (kanban 181986, Jon 2026-08-07: "the api should count
 * the time since its last call — that would be one way that we control").
 *
 * STOPPAGE = silence beyond threshold AND a started project AND cards still
 * unworked (backlog / in_progress). The board corroboration is what makes it
 * sure-fire: silence with a clear board is earned rest and never mails.
 *
 * On a crossing, mail ONE kick (JonPert, fallback BAPert) per stall episode:
 * "team silent N min, M cards unworked — deal or stand down." Re-arm only after
 * work resumes (hysteresis). The platform never auto-yanks — lanes principle:
 * guarantee visibility, actors act.
 *
 * A failed board read is NO MEASUREMENT, and no measurement is not a red: the
 * tick logs and skips. Kick delivery failure leaves the episode un-kicked so
 * the next tick retries.
 */

interface BoardStorage {
  getActiveProjectId(): Promise<number | null>;
  listTasks(filter: { projectId: number }): Promise<Array<{ status: string }>>;
}

type KickSender = (to: string[], subject: string, body: string) => Promise<unknown>;

const UNWORKED_STATUSES = new Set(['backlog', 'in_progress']);

export class WorkStoppageMonitor {
  private readonly cfg: Config;
  private readonly storage: BoardStorage;
  private readonly activity: WorkActivity;
  private readonly sendKick: KickSender;
  private timer: ReturnType<typeof setInterval> | null = null;
  private kickedThisEpisode = false;
  private tickInFlight = false;

  constructor(cfg: Config, storage: BoardStorage, activity: WorkActivity, sendKick: KickSender) {
    this.cfg = cfg;
    this.storage = storage;
    this.activity = activity;
    this.sendKick = sendKick;
  }

  start(): void {
    const tickMs = this.cfg.workStoppageTickSeconds * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    // Never hold the process open on our own (QAPert 22443 rider): the real
    // server stays up via its listener and shutdown.ts stops us; a scratch or
    // test boot that never wires shutdown handlers must still be able to exit.
    this.timer.unref?.();
    console.log(
      `[WorkStoppageMonitor] Started, tick every ${this.cfg.workStoppageTickSeconds}s, ` +
        `silence threshold ${this.cfg.workStoppageSilenceMinutes}m`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One evaluation pass. Public (and injectable clock) so tests can drive it synchronously. */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const snap = this.activity.snapshot(now);
      if (snap.silenceSeconds < this.cfg.workStoppageSilenceMinutes * 60) {
        // Work observed inside the window — re-arm for the next episode.
        this.kickedThisEpisode = false;
        return;
      }
      if (this.kickedThisEpisode) return; // one kick per stall episode

      let unworked = 0;
      try {
        const projectId = await this.storage.getActiveProjectId();
        if (projectId == null) return; // no project engaged on this rig — nothing to corroborate
        const tasks = await this.storage.listTasks({ projectId });
        unworked = tasks.filter((t) => UNWORKED_STATUSES.has(t.status)).length;
      } catch (err: any) {
        console.warn(
          `[WorkStoppageMonitor] board read failed — no measurement is not a red, skipping tick: ${err?.message || err}`,
        );
        return;
      }
      if (unworked === 0) return; // silence with a clear board is earned rest

      const minutes = Math.floor(snap.silenceSeconds / 60);
      const subject = `WORK-STOPPAGE: team silent ${minutes} min, ${unworked} card(s) unworked`;
      const body = [
        `Work-stoppage detection (kanban 181986).`,
        ``,
        `Team silent ${minutes} min (threshold ${this.cfg.workStoppageSilenceMinutes} min) with ${unworked} card(s) in backlog/in_progress.`,
        `Last work-bearing call: ${snap.lastWorkCallAt} (heartbeats and platform mail do not count).`,
        ``,
        `Per-agent last work call:`,
        ...(Object.keys(snap.perAgent).length
          ? Object.entries(snap.perAgent).map(([name, at]) => `- ${name}: ${at}`)
          : ['- (none recorded this process lifetime)']),
        ``,
        `Deal or stand down. The platform guarantees visibility; the decision is yours — nothing is auto-yanked.`,
      ].join('\n');

      try {
        const r1: any = await this.sendKick(['JonPert'], subject, body);
        this.kickedThisEpisode = true;
        console.warn(`[WorkStoppageMonitor] KICK sent to JonPert (mail id ${r1?.data?.id ?? r1?.data?.message_id ?? 'unknown'}): ${subject}`);
      } catch (err: any) {
        console.warn(`[WorkStoppageMonitor] JonPert kick failed (${err?.message || err}); trying BAPert`);
        try {
          const r2: any = await this.sendKick(['BAPert'], subject, body);
          this.kickedThisEpisode = true;
          console.warn(`[WorkStoppageMonitor] KICK sent to BAPert (fallback, mail id ${r2?.data?.id ?? r2?.data?.message_id ?? 'unknown'}): ${subject}`);
        } catch (err2: any) {
          console.error(
            `[WorkStoppageMonitor] kick undeliverable (JonPert and BAPert): ${err2?.message || err2}`,
          );
          // kickedThisEpisode stays false — the next tick retries while the stall continues.
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
