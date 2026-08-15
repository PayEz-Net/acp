import { Router, type Request, type Response } from 'express';
import { Pool } from 'pg';
import { config } from '../../config.js';
import { success } from '../response.js';
import { getStartedProjectId } from '../projects/startedProject.js';

/**
 * GET /v1/agents/:agent/session-summary
 *
 * Returns the agent's most recent stored session summary from the shared kb
 * store, so the BOOT PROMPT can carry it. This exists because memory recall is
 * NOT runtime-agnostic: `kb_recall.py` is registered as a Claude Code
 * UserPromptSubmit hook in `.claude/settings.json`, and Kimi never reads that
 * file. A Kimi agent therefore starts every launch with no memory at all.
 *
 * That matters because of the session-rotation policy (AcpRuntimeManager,
 * 2026-08-07): every app launch starts a FRESH session on purpose — the
 * immortal-resume pattern was costing ~250k cached-read tokens per turn. The
 * policy's justification is that "continuity lives server-side". For Claude
 * that is true via the hook; for Kimi it was not true at all until this route.
 *
 * Serving it over HTTP rather than shelling out to the Python hook is
 * deliberate: the hooks hardcode `E:\Repos\...` paths, which do not exist on
 * macOS, and the rig is meant to run there too.
 *
 * FAILS SOFT, ALWAYS. A boot prompt without a summary is degraded; a boot
 * prompt that never arrives is a dead agent. Every failure path returns
 * `summary: null` and logs — it must never throw into the spawn path.
 */

// Lazily created so a rig with no kb configured pays nothing and logs once.
let pool: Pool | null = null;
let poolInitFailed = false;
let missingConfigLogged = false;

function getPool(): Pool | null {
  if (pool || poolInitFailed) return pool;
  const url = config.kbDatabaseUrl;
  if (!url) {
    if (!missingConfigLogged) {
      missingConfigLogged = true;
      // Stated loudly ONCE. This is a real capability gap, not a default:
      // agents will boot with no prior context and nothing else will say so.
      console.warn(
        '[session-summary] KB_DATABASE_URL is not set — agents will boot WITHOUT their prior session summary. ' +
          'Set it to the kb store (e.g. postgresql://kb:<pw>@10.0.0.93:54320/kb) to enable boot continuity.',
      );
    }
    return null;
  }
  try {
    pool = new Pool({
      connectionString: url,
      max: 2,
      // The boot path is latency-sensitive: an agent waiting on this is an
      // agent not starting. Better to boot without the summary than to hang.
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.warn('[session-summary] idle client error:', err.message));
    return pool;
  } catch (err: any) {
    poolInitFailed = true;
    console.warn('[session-summary] could not create kb pool:', err?.message);
    return null;
  }
}

export async function getLatestSessionSummary(
  agent: string,
): Promise<{ summary: string; source: string | null; createdAt: string } | null> {
  const p = getPool();
  if (!p) return null;

  // THE PROJECT IS RESOLVED HERE, not passed in. This function exists to answer
  // "what was this agent doing", and the answer is meaningless without saying
  // WHICH PROJECT it was doing it on. Making it a parameter would let a future
  // caller omit it — and omitting it is precisely the defect being fixed
  // (2026-08-14): summaries were keyed by agent alone, so starting project B
  // handed its agents project A's next-actions list, and because a present
  // summary IS the resume signal, they began executing it without pausing.
  //
  // No engaged project => no summary => cold start. That is the safe failure:
  // a cold start costs an agent some orientation, a wrong resume costs a day.
  const projectId = getStartedProjectId();
  if (projectId === null) {
    console.warn(`[session-summary] ${agent}: no project engaged — booting without a summary`);
    return null;
  }

  try {
    // EXACT scope_id match, never a prefix. `QAPert` must not be handed
    // `QAPert-NightHawk`'s state — that bleed happened once (2026-08-09) and
    // an agent resumed believing it left off inside another agent's work.
    // Parameterised, so an agent name cannot alter the query.
    //
    // Title is now an EQUALITY too, not a LIKE: there is one summary per agent
    // per project, so there is nothing to pattern-match against.
    // project_id has NO `or project_id = 0` escape here. Globals are right for
    // doctrine; a session summary that claims to belong to every project is the
    // bug, so an unscoped row must stay unreadable rather than universally read.
    const { rows } = await p.query(
      `select chunk, source, created_at
         from kb
        where scope = 'agent'
          and scope_id = $1
          and project_id = $2
          and title = $3
          and (expires_at is null or expires_at > now())
        order by created_at desc
        limit 1`,
      [agent, projectId, `${agent} session summary`],
    );
    if (!rows.length) return null;

    // Defensive size limit: even if a summary slipped past the shutdown guard,
    // cap it here. Prevents accidental budget drain at boot. ~4 chars per token.
    // Keep the tail (recent context), drop the head (older background).
    const MAX_SUMMARY_TOKENS = 2000;
    const MAX_CHARS = MAX_SUMMARY_TOKENS * 4;
    let chunk = String(rows[0].chunk ?? '').trim();
    if (chunk.length > MAX_CHARS) {
      console.warn(`[session-summary] ${agent} summary oversized (${Math.round(chunk.length / 4)} tokens), truncating to ${MAX_SUMMARY_TOKENS}`);
      chunk = '[… truncated]\n\n' + chunk.slice(-MAX_CHARS);
    }

    return {
      summary: chunk,
      source: rows[0].source ?? null,
      createdAt: new Date(rows[0].created_at).toISOString(),
    };
  } catch (err: any) {
    console.warn(`[session-summary] query failed for ${agent}:`, err?.message);
    return null;
  }
}

export default function sessionSummaryRoutes(_storage?: unknown): Router {
  const router = Router();

  router.get('/:agent/session-summary', async (req: Request, res: Response) => {
    const agent = String(req.params.agent || '').trim();
    if (!agent) {
      res.json(success({ summary: null }, 'session_summary', (req as any).requestId));
      return;
    }
    // Query for short summary (title = "*session summary (short)*") — all agents get this at boot.
    // They can query the full session from the KB if they need detailed context.
    const found = await getLatestSessionSummary(agent);
    res.json(
      success(
        found
          ? { summary: found.summary, source: found.source, created_at: found.createdAt }
          : { summary: null },
        'session_summary',
        (req as any).requestId,
      ),
    );
  });

  return router;
}
