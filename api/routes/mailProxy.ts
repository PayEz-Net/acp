import { Router, type Request, type Response } from 'express';
import { error } from '../response.js';
import type { Config } from '../../config.js';
import type { ContractorService } from '../contractors/service.js';
import type { SessionManager } from '../contractors/sessionManager.js';
import { ensureValidToken, forceRefresh } from '../auth/tokenManager.js';
import { signVibeRequest } from '../auth/vibeHmac.js';

const AGENTMAIL_BASE = '/v1/agentmail';
const PROXY_TIMEOUT_MS = 10_000;

export class NotAuthenticatedError extends Error {
  constructor() {
    super('No active IDP session — user must log in via POST /v1/auth/login');
    this.name = 'NotAuthenticatedError';
  }
}

function buildAuthHeaders(
  cfg: Config,
  token: string,
  method: 'GET' | 'POST',
  signedPath: string,
): Record<string, string> {
  const hmacHeaders = process.env.VIBE_AUTH_MODE === 'hmac'
    ? signVibeRequest(method, signedPath, {
    clientId: cfg.vibeClientId,
    signingKey: cfg.vibeHmacKey,
  })
    : {};
  return {
    ...hmacHeaders,
    'Authorization': `Bearer ${token}`,
    'X-Client-Id': String(cfg.vibeIdealVibeClientNum),
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

  let token = await ensureValidToken(cfg.idpUrl);
  if (!token) {
    throw new NotAuthenticatedError();
  }

  const signedPath = `${AGENTMAIL_BASE}${path}`;

  const doFetch = async (bearer: string): Promise<{ status: number; data: unknown }> => {
    const headers = buildAuthHeaders(cfg, bearer, method, signedPath);
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

  const refreshed = await forceRefresh(cfg.idpUrl);
  if (!refreshed) {
    throw new NotAuthenticatedError();
  }
  return doFetch(refreshed);
}

type MailSentCallback = (fromAgent: string, subject: string, toAgents: string[]) => void;

function sendProxyError(res: Response, req: Request, err: any, operation: string): void {
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json(
      error('NOT_AUTHENTICATED', err.message, operation, (req as any).requestId)
    );
    return;
  }
  const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
  res.status(502).json(
    error('PROXY_ERROR', `Mail proxy failed: ${msg}`, operation, (req as any).requestId)
  );
}

export default function mailProxyRoutes(
  cfg: Config,
  onMailSent?: MailSentCallback,
  contractorService?: ContractorService,
  sessionManager?: SessionManager,
): Router {
  const router = Router();

  // GET /v1/mail/inbox/:agent -> idealvibe.online/v1/agentmail/inbox/:agent
  router.get('/inbox/:agent', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `/inbox/${req.params.agent}`, 'GET', req.query as Record<string, any>);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_inbox');
    }
  });

  // GET /v1/mail/messages/:message_id -> idealvibe.online/v1/agentmail/messages/:message_id
  router.get('/messages/:message_id', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `/messages/${req.params.message_id}`, 'GET', req.query as Record<string, any>);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_read');
    }
  });

  // POST /v1/mail/send -> idealvibe.online/v1/agentmail/send
  // v2: Validates recipients (no more hiring side-effect — use POST /v1/contractors/hire)
  router.post('/send', async (req: Request, res: Response) => {
    try {
      const { from_agent, to, subject } = req.body || {};

      // v2: validate recipients — reject unknown names (AC-11), pass existing agents (AC-12)
      if (contractorService && from_agent && Array.isArray(to)) {
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

      // Proxy to cloud
      const cloudResult = await proxyToCloud(cfg, '/send', 'POST', undefined, req.body);
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
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_mark_read');
    }
  });

  // POST /v1/mail/inbox/:agent/read-all -> Mark all messages as read for agent
  // This is a local convenience endpoint that batches individual mark-read calls
  router.post('/inbox/:agent/read-all', async (req: Request, res: Response) => {
    try {
      const agentName = req.params.agent;
      
      // First, fetch all messages for the agent
      const inboxResult = await proxyToCloud(cfg, `/inbox/${agentName}`, 'GET', { page: 1, page_size: 100 });
      
      const inboxData = inboxResult.data as any;
      if (inboxResult.status !== 200 || !inboxData?.success) {
        res.status(inboxResult.status).json(inboxData);
        return;
      }
      
      const messages = inboxData.data?.messages || [];
      const unreadMessages = messages.filter((m: any) => !m.read_at);
      
      if (unreadMessages.length === 0) {
        res.json({
          success: true,
          data: { marked: 0, total: messages.length },
          message: 'No unread messages to mark'
        });
        return;
      }
      
      // Mark each unread message as read using inbox_id
      let markedCount = 0;
      const errors: string[] = [];
      
      for (const msg of unreadMessages) {
        const inbox_id = msg.inbox_id;
        try {
          const result = await proxyToCloud(cfg, `/inbox/${inbox_id}/read`, 'POST');
          const resultData = result.data as any;
          if (result.status === 200 && resultData?.success) {
            markedCount++;
          } else {
            errors.push(`inbox_id ${inbox_id}: ${resultData?.error || 'Unknown error'}`);
          }
        } catch (err: any) {
          errors.push(`inbox_id ${inbox_id}: ${err.message}`);
        }
      }
      
      res.json({
        success: markedCount > 0,
        data: { 
          marked: markedCount, 
          total: unreadMessages.length,
          agent: agentName
        },
        errors: errors.length > 0 ? errors : undefined,
        message: `Marked ${markedCount}/${unreadMessages.length} messages as read`
      });
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_mark_all_read');
    }
  });

  // GET /v1/mail/agents -> idealvibe.online/v1/agentmail/agents
  router.get('/agents', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, '/agents', 'GET', req.query as Record<string, any>);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_agents');
    }
  });

  return router;
}
