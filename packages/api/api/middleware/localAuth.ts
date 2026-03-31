import type { Request, Response, NextFunction } from 'express';
import { error } from '../response.js';

/** Routes that require Bearer auth only — agents never call these directly (AC-5) */
const BEARER_ONLY_PATTERN = /\/v1\/agents\/[^/]+\/(register|deregister)$/;

interface AgentStorage {
  getAgentRegistration(agentId: string): Promise<unknown | null>;
}

/**
 * Local auth middleware for acp-api.
 *
 * Supports two auth patterns (AC-3, AC-1):
 *   1. Authorization: Bearer {ACP_LOCAL_SECRET} — renderer / Electron (original)
 *   2. X-ACP-Agent: {agentName} — agents inside ACP (new)
 *
 * Bearer takes precedence when both are present (AC-8).
 * Hook endpoints (register/deregister) remain Bearer-only (AC-5).
 * req.agentName is set on all authenticated requests (AC-4).
 */
export function localAuth(secret: string | null, storage?: AgentStorage) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // /health is unauthenticated for startup probes
    if (req.path === '/health') {
      next();
      return;
    }

    // OPTIONS preflight is unauthenticated
    if (req.method === 'OPTIONS') {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const agentHeader = req.headers['x-acp-agent'] as string | undefined;

    // --- Bearer auth (takes precedence — AC-8) ---
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (secret && token === secret) {
        // Bearer valid — use X-ACP-Agent for identity if present, otherwise 'system'
        (req as any).agentName = agentHeader || 'system';
        next();
        return;
      }
      // Bearer present but invalid — reject
      res.status(401).json(
        error('UNAUTHORIZED', 'Invalid bearer token', 'auth', (req as any).requestId)
      );
      return;
    }

    // --- Bearer-only routes cannot use agent identity auth (AC-5) ---
    if (BEARER_ONLY_PATTERN.test(req.originalUrl || req.path)) {
      res.status(401).json(
        error('UNAUTHORIZED', 'This endpoint requires Bearer authentication', 'auth', (req as any).requestId)
      );
      return;
    }

    // --- Agent Identity auth (X-ACP-Agent header — AC-1) ---
    if (agentHeader && storage) {
      try {
        const reg = await storage.getAgentRegistration(`agent:${agentHeader}`);
        if (reg) {
          (req as any).agentName = agentHeader;
          next();
          return;
        }
      } catch {
        // Storage error — fall through to 401
      }
      // Agent name not registered (AC-2)
      res.status(401).json(
        error('UNAUTHORIZED', `Agent '${agentHeader}' is not registered`, 'auth', (req as any).requestId)
      );
      return;
    }

    // --- Neither auth method present (AC-7) ---
    res.status(401).json(
      error('UNAUTHORIZED', 'Missing authentication: provide Bearer token or X-ACP-Agent header', 'auth', (req as any).requestId)
    );
  };
}
