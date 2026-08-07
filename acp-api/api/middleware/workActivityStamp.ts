import type { Request, Response, NextFunction } from 'express';
import type { WorkActivity } from '../lifecycle/workActivity.js';

/**
 * Activity stamp (kanban 181986) — records work-bearing agent calls.
 *
 * What does NOT count as work, and why:
 * - NON_WORK_PREFIXES: heartbeat / health / SSE keepalive surfaces. They fire
 *   all night from brain-idle agents — the overnight stall ran ~8h with the
 *   18:05 and 22:16 heartbeat bursts still chattering. Counting them would
 *   mask exactly the silence this feature exists to detect.
 * - PLATFORM_MAIL_SUBJECTS on POST /v1/mail/send: the supervisor's keep-alive
 *   ping and this monitor's own WORK-STOPPAGE kick are platform-originated
 *   mail. Stamping either lets the platform reset the timer it is supposed to
 *   be measured by (and the kick would re-arm the monitor it just tripped).
 * - Bearer-authenticated calls are never stamped: Bearer is the renderer/human
 *   path (localAuth), and human desktop polling is not agent work. Only
 *   authMethod === 'agent' (X-ACP-Agent) calls count.
 */
const NON_WORK_PREFIXES = ['/health', '/v1/sse', '/v1/agent-sessions'];
const PLATFORM_MAIL_SUBJECTS = ['UNATTENDED PING', 'WORK-STOPPAGE'];

export function workActivityStamp(activity: WorkActivity) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if ((req as any).authMethod === 'agent') {
      const path = req.path || '';
      const isNonWorkPath = NON_WORK_PREFIXES.some((p) => path.startsWith(p));
      // Read-only mail GETs never stamp (QAPert 22443): a standing inbox-poll
      // cron is the exact brain-idle-but-chattering shape this feature exists
      // to catch. Mail READS that precede real work are followed by work calls
      // that stamp elsewhere; a poll that precedes nothing stamps nothing.
      // Sends and read-all remain work — they are deliberate acts, not polls.
      const isMailReadPoll = req.method === 'GET' && path.startsWith('/v1/mail/');
      const isPlatformMail =
        req.method === 'POST' &&
        path === '/v1/mail/send' &&
        PLATFORM_MAIL_SUBJECTS.some((s) => String((req.body as any)?.subject ?? '').startsWith(s));
      if (!isNonWorkPath && !isMailReadPoll && !isPlatformMail) {
        activity.record((req as any).agentName || 'unknown');
      }
    }
    next();
  };
}
