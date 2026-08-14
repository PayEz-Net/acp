import { Router, type Request, type Response } from 'express';
import { error, success } from '../response.js';
import { composeBrief, MAX_MAILS_SUMMARISED } from '../mail/briefComposer.js';
import type { Config } from '../../config.js';
import type { ContractorService } from '../contractors/service.js';
import type { SessionManager } from '../contractors/sessionManager.js';
import { ensureValidToken, forceRefresh, getSession, requireTokenClientId } from '../auth/tokenManager.js';
import * as projectsCache from '../projects/cache.js';
import { requireStartedProjectId, ProjectNotEngagedError } from '../projects/startedProject.js';

const AGENTMAIL_BASE = '/v1/agentmail';
const PROXY_TIMEOUT_MS = 10_000;
/** How an AGENT reaches this sidecar — printed into brief text so the reply
 *  instructions are copy-pasteable from inside a pane. */
const ACP_SELF_BASE = (process.env.ACP_API_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');

export class NotAuthenticatedError extends Error {
  constructor() {
    super('No active IDP session — user must log in via POST /v1/auth/login');
    this.name = 'NotAuthenticatedError';
  }
}

// Decision-C: Bearer-only (no Vibe HMAC secret in the user-session build). The
// cloud accepts a validated IDP Bearer with a client_id claim in lieu of HMAC.
// X-Client-Id mirrors the BEARER'S OWN client_id (the user's tenant), not a
// build-time constant — see requireTokenClientId. The old hardcoded idealvibe
// client (9) 401'd every beta tenant (e.g. 46) at the Vibe admin gate.
function buildAuthHeaders(_cfg: Config, token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'X-Client-Id': requireTokenClientId(token),
    'X-Vibe-Via': 'idp-proxy',
    'Content-Type': 'application/json',
  };
}

/**
 * Forwards query parameters from the incoming request as a URL query string.
 */
function buildQueryString(query: Record<string, any>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Proxies a request to idealvibe.online agentmail API with auth headers.
 * Includes a 10s timeout via AbortController to prevent hanging.
 */
async function proxyToCloud(
  cfg: Config,
  path: string,
  method: 'GET' | 'POST',
  query?: Record<string, any>,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  const qs = query ? buildQueryString(query) : '';
  const url = `${cfg.vibeApiUrl}${AGENTMAIL_BASE}${path}${qs}`;

  let token = await ensureValidToken(cfg.idpUrl, 'ensureValidToken@mail');
  if (!token) {
    throw new NotAuthenticatedError();
  }


  const doFetch = async (bearer: string): Promise<{ status: number; data: unknown }> => {
    const headers = buildAuthHeaders(cfg, bearer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const opts: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body && method === 'POST') {
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(url, opts);
      const text = await res.text();
      if (!text) {
        return {
          status: res.status,
          data: { success: res.ok, data: null },
        };
      }
      try {
        return { status: res.status, data: JSON.parse(text) };
      } catch {
        return {
          status: res.status,
          data: {
            success: false,
            error: {
              code: 'UPSTREAM_NON_JSON',
              message: `Upstream returned non-JSON body (HTTP ${res.status}): ${text.slice(0, 400)}`,
            },
          },
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const firstAttempt = await doFetch(token);
  if (firstAttempt.status !== 401) {
    return firstAttempt;
  }

  const refreshed = await forceRefresh(cfg.idpUrl, 'forceRefresh-on-401@mail');
  if (!refreshed) {
    throw new NotAuthenticatedError();
  }
  return doFetch(refreshed);
}

type MailSentCallback = (fromAgent: string, subject: string, toAgents: string[]) => void;

// SESSION_INACTIVE rewrite: the cloud transiently 404s with
// {"code":"SESSION_INACTIVE","message":"Session is not active"} during backend
// blips (observed recovering on its own within ~a minute). Agents read that
// body LITERALLY — "my session is not active" — and go permanently silent,
// and the error then sits in the CLI session history and keeps poisoning
// every resume. Never let that phrase reach an agent: rewrite it to a
// retryable 503 whose wording cannot be misread as deactivation.
// Detection is by error code on any 4xx, so a status change upstream can't
// re-open the hole.
function isSessionInactiveResult(status: number, data: unknown): boolean {
  if (status < 400 || status >= 500) return false;
  const code = (data as any)?.error?.code;
  return typeof code === 'string' && code.toUpperCase() === 'SESSION_INACTIVE';
}

const SESSION_INACTIVE_REWRITE_MESSAGE =
  'The mail platform had a transient hiccup (stale session-registration data upstream — it typically recovers within a minute). ' +
  'This is NOT about you: your agent session is live and you are fully active. ' +
  'Retry this exact call in about 30 seconds and continue working normally.';

function rewriteSessionInactive(
  res: Response,
  req: Request,
  operation: string,
  routeLabel: string,
): void {
  console.warn(
    `[mailProxy] upstream SESSION_INACTIVE on ${routeLabel} — rewriting to transient 503 so the agent does not read it as deactivation`,
  );
  res.status(503).json(
    error('MAIL_UPSTREAM_TRANSIENT', SESSION_INACTIVE_REWRITE_MESSAGE, operation, (req as any).requestId)
  );
}

function sendProxyError(res: Response, req: Request, err: any, operation: string): void {
  if (err instanceof ProjectNotEngagedError) {
    res.status(409).json(
      error('PROJECT_NOT_ENGAGED', err.message, operation, (req as any).requestId)
    );
    return;
  }
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json(
      error('NOT_AUTHENTICATED', err.message, operation, (req as any).requestId)
    );
    return;
  }
  if (err instanceof ProjectNotEngagedError) {
    res.status(err.status).json(
      error(err.code, err.message, operation, (req as any).requestId)
    );
    return;
  }
  const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
  res.status(502).json(
    error('PROXY_ERROR', `Mail proxy failed: ${msg}`, operation, (req as any).requestId)
  );
}

/**
 * Mark inbox rows read — THE one implementation of the rule.
 *
 * Marks by `inbox_id`, never `message_id`. Those are different sequences
 * (message 27804 lives in inbox row 87106) and the route below takes the inbox
 * one, so handing it a message id names a real but UNRELATED row and marks that
 * read — returning `200 {"success":true}` either way. Measured 2026-08-14: 88
 * wrong rows written before anyone noticed, because the caller checked only the
 * status code while the response body named the row it had actually touched.
 *
 * So: verify. A mark counts only when the server says it acted on the message
 * we asked for. Never report a mark that did not happen — the caller uses this
 * to decide whether mail can stop being re-offered.
 */
async function markRowsRead(
  cfg: Config,
  agent: string,
  rows: Array<{ inbox_id?: number; message_id?: number }>,
): Promise<number[]> {
  const marked: number[] = [];
  for (const row of rows) {
    if (row.inbox_id == null) {
      console.warn(`[mailBrief] ${agent}: message ${row.message_id} has no inbox_id — cannot mark read`);
      continue;
    }
    const r = await proxyToCloud(cfg, `/inbox/${row.inbox_id}/read`, 'POST');
    const actedOn = (r.data as any)?.data?.message_id;
    if (r.status >= 200 && r.status < 300 && (actedOn == null || actedOn === row.message_id)) {
      if (row.message_id != null) marked.push(row.message_id);
    } else {
      console.warn(
        `[mailBrief] ${agent}: mark-read mismatch — asked for ${row.message_id} ` +
        `(inbox ${row.inbox_id}), server reported ${actedOn ?? `HTTP ${r.status}`}`,
      );
    }
  }
  return marked;
}

export default function mailProxyRoutes(
  cfg: Config,
  onMailSent?: MailSentCallback,
  contractorService?: ContractorService,
  sessionManager?: SessionManager,
): Router {
  const router = Router();

  // GET /v1/mail/inbox/:agent -> idealvibe.online/v1/agentmail/inbox/:agent
  // Every route below stamps the STARTED project, or refuses. There is no
  // unfiltered call to the cloud from this file — that is what leaked mail
  // between projects.
  router.get('/inbox/:agent', async (req: Request, res: Response) => {
    try {
      const query: Record<string, any> = { ...(req.query as Record<string, any>) };
      query.project_id = requireStartedProjectId(`reading ${req.params.agent}'s inbox`);
      const result = await proxyToCloud(cfg, `/inbox/${req.params.agent}`, 'GET', query);

      // TEMP-SHIM(agent-identity-overhaul): the cloud agent registry is mid-rebuild.
      // Inbox identity resolves over (vibe_agents/agent_profiles ∪
      // vibe_projects.team_agent_instances) BY NAME, so known-broken seed data makes
      // some roster agents 404 (name no longer resolves) or 403 (owned by another
      // user / not shared). That's a DATA problem being fixed in the idealvibe
      // teams/agents/projects overhaul, not a transport error — so for the read-only
      // inbox POLL we downgrade those two statuses to an empty inbox instead of
      // spamming the cockpit. NOT a silent soften: the real upstream status is logged
      // every poll. 401 (auth) and real failures (5xx/502) still pass through.
      // Remove this whole block when the overhaul lands. grep: TEMP-SHIM(agent-identity-overhaul)
      if (result.status === 403 || result.status === 404) {
        const upstreamErr = (result.data as any)?.error;
        console.warn(
          `[mailProxy] TEMP-SHIM inbox/${req.params.agent}: upstream ${result.status} ` +
          `(${upstreamErr?.code ?? '?'}: ${upstreamErr?.message ?? 'n/a'}) — returning empty inbox ` +
          `until agent-identity overhaul lands`,
        );
        res.status(200).json({ success: true, data: { messages: [], unread_count: 0 } });
        return;
      }

      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_inbox');
    }
  });

  // GET /v1/mail/inboxes?agents=a,b,c -> ONE response carrying every agent's inbox.
  // P0 (Jon 2026-06-13): the renderer's fetchAllInboxes did Promise.all(agents.map(GET /inbox/:agent)),
  // an N-request CLIENT fan-out fired by 5 stacking triggers (poll/focus/mount/every-SSE-event/post-read)
  // that burst past the acp-api rate limiter -> 429 -> EVERY inbox failed at once -> team comms lockup.
  // This collapses the client to a SINGLE request; the sidecar fans out to the cloud with BOUNDED
  // concurrency (gentle upstream). Per-agent failures are ISOLATED — one agent's 4xx/5xx/timeout is
  // recorded against that agent and never drops the others or fails the batch (QA 6751 axis-2:
  // "returns EVERY inbox the x5 fan-out did, no agent lost"). Same project_id stamping + the same
  // TEMP-SHIM(agent-identity-overhaul) 403/404->empty downgrade as GET /inbox/:agent, applied per agent.
  // Response: { success, data: { inboxes: { [agent]: { messages, unread_count, error? } } } }.
  router.get('/inboxes', async (req: Request, res: Response) => {
    try {
      const raw = (req.query.agents as string | undefined) ?? '';
      const requested = raw.split(',').map((a) => a.trim()).filter((a) => a.length > 0);
      if (requested.length === 0) {
        res.status(400).json(
          error('VALIDATION_ERROR', 'agents query param is required (comma-separated agent names)', 'mail_inboxes', (req as any).requestId)
        );
        return;
      }
      // De-dupe so a roster with repeats can't multiply the upstream calls.
      const agents = [...new Set(requested)];

      const baseQuery: Record<string, any> = { ...(req.query as Record<string, any>) };
      delete baseQuery.agents;                       // the agent list is ours, not an upstream inbox param
      baseQuery.project_id = requireStartedProjectId('reading team inboxes');

      type InboxEntry = { messages: unknown[]; unread_count: number; error?: { code: string; message: string } };
      const inboxes: Record<string, InboxEntry> = {};

      // Bounded-concurrency worker pool (NOT Promise.all of N) — predictable, gentle upstream.
      const CONCURRENCY = 4;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < agents.length) {
          const agent = agents[cursor++];
          try {
            const result = await proxyToCloud(cfg, `/inbox/${encodeURIComponent(agent)}`, 'GET', baseQuery);

            // TEMP-SHIM(agent-identity-overhaul): identical to GET /inbox/:agent — a 403/404 from the
            // mid-rebuild cloud agent registry is a DATA problem, not transport; downgrade to empty inbox
            // (real status logged). Remove with the single-route shim. grep: TEMP-SHIM(agent-identity-overhaul)
            if (result.status === 403 || result.status === 404) {
              const upstreamErr = (result.data as any)?.error;
              console.warn(
                `[mailProxy] TEMP-SHIM inboxes/${agent}: upstream ${result.status} ` +
                `(${upstreamErr?.code ?? '?'}: ${upstreamErr?.message ?? 'n/a'}) — returning empty inbox`,
              );
              inboxes[agent] = { messages: [], unread_count: 0 };
              continue;
            }

            if (result.status >= 200 && result.status < 300) {
              const data = (result.data as any)?.data ?? {};
              inboxes[agent] = {
                messages: Array.isArray(data.messages) ? data.messages : [],
                unread_count: typeof data.unread_count === 'number' ? data.unread_count : 0,
              };
            } else {
              // Per-agent failure — record it, keep the batch (no agent lost).
              const upstreamErr = (result.data as any)?.error;
              inboxes[agent] = {
                messages: [],
                unread_count: 0,
                error: {
                  code: upstreamErr?.code ?? `UPSTREAM_${result.status}`,
                  message: upstreamErr?.message ?? `Upstream HTTP ${result.status}`,
                },
              };
            }
          } catch (e: any) {
            // A dead session is whole-request fatal (consistent with the single inbox route); let it bubble.
            if (e instanceof NotAuthenticatedError) throw e;
            inboxes[agent] = {
              messages: [],
              unread_count: 0,
              error: { code: 'PROXY_ERROR', message: e?.name === 'AbortError' ? 'Upstream timeout (10s)' : (e?.message ?? 'proxy error') },
            };
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, agents.length) }, () => worker()));

      res.status(200).json({ success: true, data: { inboxes } });
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_inboxes');
    }
  });

  // GET /v1/mail/messages/:message_id -> idealvibe.online/v1/agentmail/messages/:message_id
  router.get('/messages/:message_id', async (req: Request, res: Response) => {
    try {
      const query: Record<string, any> = { ...(req.query as Record<string, any>) };
      query.project_id = requireStartedProjectId(`reading message ${req.params.message_id}`);
      const result = await proxyToCloud(cfg, `/messages/${req.params.message_id}`, 'GET', query);

      if (isSessionInactiveResult(result.status, result.data)) {
        rewriteSessionInactive(res, req, 'mail_read', `messages/${req.params.message_id}`);
        return;
      }

      // Strip experimental ActionPanel fields that never shipped (BAPert 1369).
      // The actions array was an adopted spec that didn't get functional UI
      // support; agents see them in JSON but can't execute them. Remove so
      // clients don't display broken action hints.
      const data = result.data as any;
      if (data && typeof data === 'object') {
        if (data.data && typeof data.data === 'object') {
          delete data.data.actions;
          delete data.data.suggested;
          delete data.data.context;
        }
        delete data.actions;
        delete data.suggested;
        delete data.context;
      }

      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_read');
    }
  });

  // POST /v1/mail/send -> idealvibe.online/v1/agentmail/send
  // v2: Validates recipients (no more hiring side-effect — use POST /v1/contractors/hire)
  // WO-agent-mail-project-isolation §Sidecar: stamp project_id from session's
  // cached current-project before forwarding. Cloud-side enforces.
  router.post('/send', async (req: Request, res: Response) => {
    try {
      const { from_agent, to, subject } = req.body || {};

      // Basic input validation before any upstream call
      if (!from_agent || typeof from_agent !== 'string' || from_agent.trim().length === 0) {
        res.status(400).json(
          error('VALIDATION_ERROR', 'from_agent is required and must be a non-empty string', 'mail_send', (req as any).requestId)
        );
        return;
      }
      if (!Array.isArray(to) || to.length === 0 || to.some((r: any) => typeof r !== 'string' || r.trim().length === 0)) {
        res.status(400).json(
          error('VALIDATION_ERROR', 'to must be a non-empty array of non-empty string recipient names', 'mail_send', (req as any).requestId)
        );
        return;
      }

      // v2: validate recipients — reject unknown names (AC-11), pass existing agents (AC-12)
      if (contractorService) {
        for (const recipientName of to) {
          const result = await contractorService.resolveRecipient(from_agent, recipientName);
          if (result.action === 'rejected') {
            res.status(404).json(
              error('UNKNOWN_RECIPIENT', result.error!, 'mail_send', (req as any).requestId)
            );
            return;
          }
        }
      }

      // Sidecar attach (WO-agent-mail-project-isolation §Sidecar): stamp the
      // active project_id derived from acp-api's projects cache onto the
      // outgoing body. Server-derived overrides any client-supplied value
      // because the sidecar is closer to the auth boundary than the renderer.
      // Cloud-side enforcement is the final say (per WO §Cloud API).
      const forwardBody: Record<string, unknown> = { ...(req.body ?? {}) };
      forwardBody.project_id = requireStartedProjectId(`sending mail from ${from_agent ?? '?'}`);

      // Provenance stamp: record the transport-level identity claimed by the
      // caller (X-ACP-Agent header / local-auth agentName). This is separate
      // from the body-supplied `from_agent` so the gateway can compare them and
      // detect mismatches or spoof attempts. Unauthenticated paths cannot reach
      // this handler, so a missing value here is logged but not fatal.
      const claimedIdentity = (req as any).agentName ?? req.headers['x-acp-agent'];
      if (claimedIdentity) {
        forwardBody.claimed_identity = String(claimedIdentity);
      } else {
        console.warn(
          `[mailProxy] POST /send: no X-ACP-Agent / req.agentName identity available — forwarding without claimed_identity. from=${from_agent ?? '?'}`,
        );
      }

      // Proxy to cloud
      const cloudResult = await proxyToCloud(cfg, '/send', 'POST', undefined, forwardBody);
      if (isSessionInactiveResult(cloudResult.status, cloudResult.data)) {
        rewriteSessionInactive(res, req, 'mail_send', `send from=${from_agent}`);
        return;
      }
      res.status(cloudResult.status).json(cloudResult.data);

      // Post-send hooks
      if ((cloudResult.data as any)?.success) {
        // DONE: auto-completion — check if sender is a contractor completing work
        if (contractorService && from_agent && subject && Array.isArray(to)) {
          try {
            await contractorService.checkDoneAutoComplete(from_agent, subject, to);
          } catch { /* non-fatal — don't break mail delivery */ }
        }
        if (onMailSent && from_agent && subject) {
          try { onMailSent(from_agent, subject, to || []); } catch { /* non-fatal */ }
        }
      }
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_send');
    }
  });

  // POST /v1/mail/inbox/:inbox_id/read -> idealvibe.online/v1/agentmail/inbox/:inbox_id/read
  router.post('/inbox/:inbox_id/read', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `/inbox/${req.params.inbox_id}/read`, 'POST');
      if (isSessionInactiveResult(result.status, result.data)) {
        rewriteSessionInactive(res, req, 'mail_mark_read', `inbox/${req.params.inbox_id}/read`);
        return;
      }
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_mark_read');
    }
  });

  // POST /v1/mail/inbox/:agent/read-all -> cloud ATOMIC bulk read-all (project-scoped).
  // Proxies straight to the cloud's single-SQL-UPDATE endpoint
  // (AgentMailController -> AgentMailService.MarkAllAsReadAsync) instead of the old per-message
  // loop. The loop fetched only inbox page-1 (first 100 unread), could time out mid-loop on the
  // 10s proxy budget, and claimed success on partial failure. The cloud does it in one round-trip,
  // no page limit, scoped agent+client+project. (Jon / BAPert msg 1310.)
  router.post('/inbox/:agent/read-all', async (req: Request, res: Response) => {
    try {
      const agentName = req.params.agent;
      // Clears ONLY the started project's mail — never a blanket wipe.
      const query: Record<string, any> = {
        project_id: requireStartedProjectId(`marking ${agentName}'s inbox read`),
      };
      const result = await proxyToCloud(cfg, `/inbox/${agentName}/read-all`, 'POST', query);
      if (isSessionInactiveResult(result.status, result.data)) {
        rewriteSessionInactive(res, req, 'mail_mark_all_read', `inbox/${agentName}/read-all`);
        return;
      }
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_mark_all_read');
    }
  });

  // POST /v1/mail/brief/:agent — hand this agent ONE summarised brief of its
  // unread mail, and mark exactly what it was handed as read.
  //
  // This is the pull half of mail delivery. The push half (the ProjectBriefr
  // loop) offers briefs on a cadence; this lets an agent that has just finished
  // something ask "what have you got for me?" and get it immediately, instead
  // of waiting out a batching window. Jon 2026-08-14: an agent should not have
  // to sit idle to earn its mail.
  //
  // The two halves cannot double-deliver, and it needs no coordination to be
  // true: the ONLY state either path keeps is the server's unread set. An agent
  // that pulls marks its mail read, so the next push sweep simply finds nothing.
  //
  // POST, not GET: this mutates (marks read). A GET that clears an inbox is a
  // trap for anything that retries or prefetches.
  router.post('/brief/:agent', async (req: Request, res: Response) => {
    const agent = String(req.params.agent || '').trim();
    if (!agent) {
      res.status(400).json(error('VALIDATION_ERROR', 'agent is required', 'mail_brief', (req as any).requestId));
      return;
    }

    try {
      const projectId = requireStartedProjectId(`briefing ${agent}`);

      // Same call the inbox route makes — not a second implementation of it.
      const inbox = await proxyToCloud(cfg, `/inbox/${encodeURIComponent(agent)}`, 'GET', {
        unread: true,
        project_id: projectId,
      });
      if (inbox.status < 200 || inbox.status >= 300) {
        res.status(inbox.status).json(inbox.data);
        return;
      }

      const unread: any[] = ((inbox.data as any)?.data?.messages ?? []).filter((m: any) => !m?.read_at);
      // Slice BEFORE composing and BEFORE marking. The composer describes at
      // most MAX_MAILS_SUMMARISED; marking a bigger batch read would bin the
      // overflow unseen. Anything past the cap simply stays unread and leads
      // the next brief.
      const messages = unread.slice(0, MAX_MAILS_SUMMARISED);
      if (unread.length > messages.length) {
        console.log(
          `[mailBrief] ${agent}: ${unread.length} unread, briefing ${messages.length}; ` +
          `${unread.length - messages.length} stay unread for the next brief`,
        );
      }
      if (messages.length === 0) {
        res.status(200).json(
          success({ agent_name: agent, count: 0, brief: null, message_ids: [] }, 'mail_brief', (req as any).requestId),
        );
        return;
      }

      const { text, modelOk } = await composeBrief(agent, messages, ACP_SELF_BASE);

      // PULL marks on compose: the caller IS the agent, so returning the brief
      // is delivery. PUSH must not — the router still has to get it into a
      // turn, and an inject can be deferred or fail. Marking before that is
      // confirmed loses mail silently. Push passes mark_read:false and calls
      // /brief/:agent/confirm once the runtime has actually taken it.
      const shouldMark = req.body?.mark_read !== false;
      if (!shouldMark) {
        res.status(200).json(
          success(
            {
              agent_name: agent,
              count: messages.length,
              brief: text,
              model_ok: modelOk,
              message_ids: messages.map((m) => m.message_id),
              inbox_ids: messages.map((m) => m.inbox_id),
              marked_read: [],
            },
            'mail_brief',
            (req as any).requestId,
          ),
        );
        return;
      }

      const marked = await markRowsRead(cfg, agent, messages);

      res.status(200).json(
        success(
          {
            agent_name: agent,
            count: messages.length,
            brief: text,
            model_ok: modelOk,
            message_ids: messages.map((m) => m.message_id),
            marked_read: marked,
          },
          'mail_brief',
          (req as any).requestId,
        ),
      );
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_brief');
    }
  });

  // POST /v1/mail/brief/:agent/confirm  { rows: [{inbox_id, message_id}] }
  // Delivery confirmed — now the mail may stop being re-offered. Separate from
  // compose so the push path marks AFTER the runtime accepted the brief, not
  // before. Same marking rule, same verification, one implementation.
  router.post('/brief/:agent/confirm', async (req: Request, res: Response) => {
    const agent = String(req.params.agent || '').trim();
    const rows = req.body?.rows;
    if (!agent || !Array.isArray(rows)) {
      res.status(400).json(
        error('VALIDATION_ERROR', 'agent and rows[] are required', 'mail_brief_confirm', (req as any).requestId),
      );
      return;
    }
    try {
      const marked = await markRowsRead(cfg, agent, rows);
      res.status(200).json(
        success({ agent_name: agent, marked_read: marked, requested: rows.length }, 'mail_brief_confirm', (req as any).requestId),
      );
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_brief_confirm');
    }
  });

  // GET /v1/mail/agents -> idealvibe.online/v1/agentmail/agents
  router.get('/agents', async (req: Request, res: Response) => {
    try {
      // The started project overrides any caller-supplied project_id. A caller
      // asking for a different roster is asking the wrong rig.
      const query = { ...(req.query as Record<string, any>) };
      query.project_id = requireStartedProjectId('listing mail agents');
      const result = await proxyToCloud(cfg, '/agents', 'GET', query);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_agents');
    }
  });

  return router;
}
