import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import type { LocalEventBus } from '../sse/localEventBus.js';

/**
 * Agent self-report status — comprehensive-installer-v1 §4.
 *
 * Jon's authority rule: the AGENT decides its own status (self-report only). The old
 * PTY-activity inference (hooks.ts onAgentBusy/onAgentIdle) is RETIRED as the working/idle
 * authority — a status the user can't trust is worse than an honest one. This endpoint is
 * the single writer of agent status; it emits the SAME `agent-status` SSE event hooks.ts
 * uses, so the board updates by push with exactly one authority (no dual-writer drift).
 *
 * Default-idle-on-no-report is the renderer's job (an agent that NEVER calls this shows idle).
 * Here: a POST that omits or garbles `status` is BAD INPUT → 400, never silently defaulted
 * (no-unjustified-fallback; absence ≠ bad input).
 */

// Canonical AgentStatus set — mirrors acp-desktop @shared/types `AgentStatus` (types.ts:26,
// 10 values), NOT the visual ACPAgentStatus map. The onboarding message stays minimal
// (working/idle); richer states are accepted for agents that want to self-report them.
const AGENT_STATUSES = new Set<string>([
  'working',
  'spawning',
  'awaiting_review',
  'waiting_for_human',
  'blocked',
  'idle',
  'unresponsive',
  'stopped',
  'error',
  'failed',
]);

export default function statusRoutes(storage: any, eventBus: LocalEventBus): Router {
  const router = Router();

  // POST /v1/status — { status: "<AgentStatus>", note?: "<one line>" }
  // Identity = req.agentName (localAuth resolves it from the X-ACP-Agent header against the
  // live roster). No IDs to look up — the shortest possible call.
  router.post('/', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'agent_status';

      const agentName = (req as any).agentName as string | undefined;
      // Bearer (renderer/human) auth resolves to 'system' — not a self-reporting agent.
      if (!agentName || agentName === 'system') {
        res
          .status(400)
          .json(
            error(
              'INVALID_REQUEST',
              'Agent identity required: send the X-ACP-Agent header',
              'agent_status',
              (req as any).requestId,
            ),
          );
        return;
      }

      const { status, note } = (req.body || {}) as { status?: unknown; note?: unknown };

      // Unknown / missing status → 400, NO default-on-bad-input (spec §4 + §8.3.6). Absence of
      // ANY report (never calling this) defaults idle on the renderer; this is a malformed call.
      if (typeof status !== 'string' || !AGENT_STATUSES.has(status)) {
        res
          .status(400)
          .json(
            error(
              'INVALID_STATUS',
              `status must be one of: ${[...AGENT_STATUSES].join(', ')}`,
              'agent_status',
              (req as any).requestId,
            ),
          );
        return;
      }

      const summary = typeof note === 'string' && note.trim() ? note.trim() : null;

      // SINGLE AUTHORITY: emit the same agent-status SSE event hooks.ts emits → the board
      // updates by push, one writer. `note` → last_action_summary (the showSummary subline).
      // (The party signal-store mirror was removed with the party cut — WO 8201.)
      eventBus.emitAgentStatus({ agent: agentName, status, last_action_summary: summary });

      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(
        success({ agent: agentName, status, note: summary }, 'agent_status', (req as any).requestId, {
          performance: { response_time_ms: elapsed },
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
