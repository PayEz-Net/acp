import { Router, type Request, type Response } from 'express';
import { error } from '../response.js';
import type { Config } from '../../config.js';
import type { ContractorService } from '../contractors/service.js';

const AGENTMAIL_BASE = '/v1/agentmail';
const PROXY_TIMEOUT_MS = 10_000;

/**
 * Builds auth headers for idealvibe.online API.
 * Uses app-level client ID + secret (not HMAC signature — the cloud API
 * accepts these as direct credentials via X-Vibe-Client-Id/Secret).
 */
function buildAuthHeaders(cfg: Config): Record<string, string> {
  return {
    'X-Vibe-Client-Id': cfg.vibeClientId,
    'X-Vibe-Client-Secret': cfg.vibeHmacKey,
    'X-Vibe-User-Id': cfg.vibeUserId,
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
  const headers = buildAuthHeaders(cfg);

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
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

type MailSentCallback = (fromAgent: string, subject: string, toAgents: string[]) => void;

export default function mailProxyRoutes(
  cfg: Config,
  onMailSent?: MailSentCallback,
  contractorService?: ContractorService,
): Router {
  const router = Router();

  // GET /v1/mail/inbox/:agent -> idealvibe.online/v1/agentmail/inbox/:agent
  router.get('/inbox/:agent', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `/inbox/${req.params.agent}`, 'GET', req.query as Record<string, any>);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
      res.status(502).json(
        error('PROXY_ERROR', `Mail proxy failed: ${msg}`, 'mail_inbox', (req as any).requestId)
      );
    }
  });

  // GET /v1/mail/messages/:id -> idealvibe.online/v1/agentmail/messages/:id
  router.get('/messages/:id', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `/messages/${req.params.id}`, 'GET', req.query as Record<string, any>);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
      res.status(502).json(
        error('PROXY_ERROR', `Mail proxy failed: ${msg}`, 'mail_read', (req as any).requestId)
      );
    }
  });

  // POST /v1/mail/send -> idealvibe.online/v1/agentmail/send
  // With contractor resolution: checks if recipients are contractors, creates contracts
  router.post('/send', async (req: Request, res: Response) => {
    try {
      const { from_agent, to, subject } = req.body || {};

      // Run contractor resolution for each recipient (if service available)
      const contracts: any[] = [];
      if (contractorService && from_agent && Array.isArray(to) && subject) {
        for (const recipientName of to) {
          const result = await contractorService.resolveRecipient(
            from_agent,
            recipientName,
            subject,
            req.body.timeout_hours,
          );
          if (result.action === 'rejected') {
            res.status(409).json(
              error('MAX_CONTRACTS_REACHED', result.error!, 'mail_send', (req as any).requestId)
            );
            return;
          }
          if (result.action === 'new_contract' && result.contract) {
            contracts.push(result.contract);
          }
        }
      }

      // Proxy to cloud
      const cloudResult = await proxyToCloud(cfg, '/send', 'POST', undefined, req.body);
      res.status(cloudResult.status).json(cloudResult.data);

      // Post-send: update contract with cloud message ID + fire hooks
      if ((cloudResult.data as any)?.success) {
        const cloudMessageId = (cloudResult.data as any)?.data?.message_id;
        if (cloudMessageId && contracts.length > 0 && contractorService) {
          for (const contract of contracts) {
            try {
              await (contractorService as any).storage.updateContractMessageId(contract.id, cloudMessageId);
            } catch { /* non-fatal */ }
          }
        }
        if (onMailSent && from_agent && subject) {
          try { onMailSent(from_agent, subject, to || []); } catch { /* non-fatal */ }
        }
      }
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
      res.status(502).json(
        error('PROXY_ERROR', `Mail proxy failed: ${msg}`, 'mail_send', (req as any).requestId)
      );
    }
  });

  // POST /v1/mail/inbox/:id/read -> idealvibe.online/v1/agentmail/inbox/:id/read
  router.post('/inbox/:id/read', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `/inbox/${req.params.id}/read`, 'POST');
      res.status(result.status).json(result.data);
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
      res.status(502).json(
        error('PROXY_ERROR', `Mail proxy failed: ${msg}`, 'mail_mark_read', (req as any).requestId)
      );
    }
  });

  // GET /v1/mail/agents -> idealvibe.online/v1/agentmail/agents
  router.get('/agents', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, '/agents', 'GET', req.query as Record<string, any>);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
      res.status(502).json(
        error('PROXY_ERROR', `Mail proxy failed: ${msg}`, 'mail_agents', (req as any).requestId)
      );
    }
  });

  return router;
}
