import { logger } from '../logging/logger.js';
import type { Config } from '../../config.js';

/**
 * Validates configuration and external service reachability on startup.
 * Logs warnings for degraded services, fatal for required ones.
 */
export async function validateConfig(cfg: Config): Promise<{ ok: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  // Required env vars
  if (!cfg.acpLocalSecret) {
    if (cfg.nodeEnv === 'production') {
      logger.error('config', 'ACP_LOCAL_SECRET is required in production');
      return { ok: false, warnings };
    }
    warnings.push('ACP_LOCAL_SECRET not set — auth disabled (dev mode)');
    logger.warn('config', 'ACP_LOCAL_SECRET not set — auth disabled');
  }

  if (!cfg.acpCallbackPort) {
    warnings.push('ACP_CALLBACK_PORT not set — lifecycle commands will fail');
    logger.warn('config', 'ACP_CALLBACK_PORT not set');
  }

  // Check VibeSQL reachability (3s timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${cfg.vibesqlDirectUrl}/v1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      logger.info('config', 'VibeSQL reachable', { url: cfg.vibesqlDirectUrl });
    } else {
      warnings.push(`VibeSQL returned HTTP ${res.status}`);
      logger.warn('config', `VibeSQL returned HTTP ${res.status}`, { url: cfg.vibesqlDirectUrl });
    }
  } catch (err: any) {
    const msg = err.name === 'AbortError' ? 'timeout (3s)' : err.message;
    warnings.push(`VibeSQL unreachable: ${msg}`);
    logger.warn('config', `VibeSQL unreachable: ${msg}`, { url: cfg.vibesqlDirectUrl });
  }

  // Check idealvibe.online reachability (3s timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${cfg.vibeApiUrl}/v1/agentmail/agents`, {
      headers: {
        'X-Vibe-Client-Id': cfg.vibeClientId,
        'X-Vibe-Client-Secret': cfg.vibeHmacKey,
        'X-Vibe-User-Id': cfg.vibeUserId,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      logger.info('config', 'idealvibe.online reachable', { url: cfg.vibeApiUrl });
    } else {
      warnings.push(`idealvibe.online returned HTTP ${res.status}`);
      logger.warn('config', `idealvibe.online returned HTTP ${res.status}`, { url: cfg.vibeApiUrl });
    }
  } catch (err: any) {
    const msg = err.name === 'AbortError' ? 'timeout (3s)' : err.message;
    warnings.push(`idealvibe.online unreachable: ${msg}`);
    logger.warn('config', `idealvibe.online unreachable: ${msg}`, { url: cfg.vibeApiUrl });
  }

  if (warnings.length > 0) {
    logger.info('config', `Startup validation: ${warnings.length} warning(s)`, { warnings });
  } else {
    logger.info('config', 'All startup validations passed');
  }

  return { ok: true, warnings };
}
