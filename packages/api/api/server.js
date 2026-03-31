import express from 'express';
import { config } from '../config.js';
import { SessionManager } from '../agents/session_manager.js';
import { cors, requestId, timing, errorHandler } from './middleware.js';
import { success, error } from './response.js';
import { localAuth } from './middleware/localAuth.js';
import mailProxyRoutes from './routes/mailProxy.js';
import bootstrapRoutes from './routes/bootstrap.js';
import modifyRoutes from './routes/modify.js';
import execRoutes from './routes/exec.js';
import sessionRoutes from './routes/sessions.js';
import partyRoutes from './routes/party.js';
import messagingRoutes from './routes/messaging.js';
import kanbanRoutes from './routes/kanban.js';
import chatRoutes from './routes/chat.js';
import autonomyRoutes from './routes/autonomy.js';
import registryRoutes from './routes/registry.js';
import notificationRoutes from './routes/notifications.js';
import { PartyEngine } from '../collaboration/party_engine.js';
import { UpstreamSseManager } from './sse/upstreamManager.js';
import sseStreamRoutes from './routes/sseStream.js';
import { BackoffManager } from './lifecycle/backoff.js';
import { HealthMonitor } from './lifecycle/healthMonitor.js';
import agentLifecycleRoutes from './routes/agentLifecycle.js';
import { bootstrap } from '../core/bootstrap.js';
import { LocalEventBus } from './sse/localEventBus.js';
import { LifecycleHooks } from './lifecycle/hooks.js';
import { Supervisor } from '../autonomy/supervisor.js';
import { logger, setLogLevel, requestLogger } from './logging/logger.js';
import { registerShutdownHandlers } from './lifecycle/shutdown.js';
import { ContractorService } from './contractors/service.js';
import { SessionManager as ContractorSessionManager } from './contractors/sessionManager.js';
import contractorRoutes from './routes/contractors.js';
import contractRoutes from './routes/contracts.js';
import projectRoutes from './routes/projects.js';
import documentRoutes from './routes/documents.js';
import agentRoutes from './routes/agents.js';
import { validateConfig } from './lifecycle/configValidator.js';

const startTime = Date.now();

export async function createApp(cfg) {
  const appConfig = cfg || config;
  const app = express();

  // Set log level from config
  if (appConfig.logLevel) setLogLevel(appConfig.logLevel);

  app.use(express.json());
  app.use(cors(appConfig.corsOrigins));
  app.use(requestId);
  app.use(timing);
  app.use(requestLogger());

  const sessionManager = new SessionManager(appConfig);
  await sessionManager.init();
  const storage = sessionManager.storage;

  // Local auth — accepts Bearer (renderer) and/or X-ACP-Agent (agents)
  if (appConfig.nodeEnv === 'production' && !appConfig.acpLocalSecret) {
    console.error('[ACP] FATAL: ACP_LOCAL_SECRET not set in production mode');
    process.exit(1);
  }
  if (!appConfig.acpLocalSecret) {
    console.warn('[ACP] WARNING: ACP_LOCAL_SECRET not set — Bearer auth disabled, agent identity auth only');
  }
  app.use(localAuth(appConfig.acpLocalSecret || null, storage));

  // Health endpoint — unauthenticated, must respond within 1s
  // Storage probe has 500ms timeout to stay within budget
  let lastStorageStatus = 'unknown';
  app.get('/health', async (req, res) => {
    const healthStart = Date.now();
    const checks = { storage: lastStorageStatus, filesystem: 'ok' };
    try {
      await Promise.race([
        storage.init().then(() => { checks.storage = 'ok'; }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500)),
      ]);
    } catch {
      checks.storage = lastStorageStatus === 'ok' ? 'ok' : 'degraded';
    }
    lastStorageStatus = checks.storage;
    const uptimeMs = Date.now() - startTime;
    const responseMs = Date.now() - healthStart;
    res.json(success({
      ...checks,
      uptime_seconds: Math.floor(uptimeMs / 1000),
      version: '1.1.0',
      response_ms: responseMs,
    }, 'health', req.requestId));
  });

  // Local event bus for party/autonomy SSE events
  const localEventBus = new LocalEventBus();

  // Contractor service — resolution logic, pool scanning, timeout, chat integration (v2)
  const contractorService = new ContractorService(storage, localEventBus, appConfig);

  // Session manager — auto-spawn contractor sessions (Phase 2b)
  const contractorSessionManager = new ContractorSessionManager(storage, localEventBus, appConfig);
  // Orphan detection on startup
  contractorSessionManager.checkOrphans().then(n => {
    if (n > 0) logger.info(`[SessionManager] Marked ${n} orphaned contract(s) as expired`);
  }).catch(() => {});

  // Mail proxy — acp-api signs with HMAC, renderer only needs local bearer token
  // onMailSent callback wired after lifecycleHooks is created (below)
  // contractorService injected for pre-send contractor resolution
  let mailSentCallback = null;
  app.use('/v1/mail', mailProxyRoutes(appConfig, (from, subject, to) => {
    if (mailSentCallback) mailSentCallback(from, subject, to);
  }, contractorService, contractorSessionManager));

  // SSE — upstream (mail from cloud) + local (party/autonomy) events → downstream fan-out
  const upstreamSse = new UpstreamSseManager(appConfig);
  app.use('/v1/sse', sseStreamRoutes(upstreamSse, localEventBus));

  // Agent lifecycle — spawn/kill/restart via Electron callback, crash-loop backoff
  const backoffManager = new BackoffManager();
  const callbackPort = appConfig.acpCallbackPort;

  const scheduleRestart = (agentName, delay) => {
    const state = backoffManager.getOrCreate(agentName);
    state.restartTimer = setTimeout(async () => {
      try {
        const { session } = await bootstrap(sessionManager, agentName);
        const result = await fetch(`http://127.0.0.1:${callbackPort}/internal/pty/spawn`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${appConfig.acpLocalSecret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agentName, workDir: state.workDir, autoReport: state.autoReport }),
        });
        if (result.ok) {
          const data = await result.json();
          const terminalId = data?.terminalId || data?.data?.terminalId || '';
          backoffManager.markSpawned(agentName, terminalId, session.sessionId || '');
          console.log(`[Lifecycle] ${agentName}: auto-restarted successfully`);
        } else {
          state.status = 'error';
          console.error(`[Lifecycle] ${agentName}: auto-restart failed (HTTP ${result.status})`);
        }
      } catch (err) {
        state.status = 'error';
        console.error(`[Lifecycle] ${agentName}: auto-restart failed: ${err.message}`);
      }
    }, delay);
  };

  const healthMonitor = new HealthMonitor(appConfig, backoffManager, callbackPort, scheduleRestart);

  app.use('/v1/lifecycle/agents', agentLifecycleRoutes({
    cfg: appConfig,
    backoff: backoffManager,
    healthMonitor,
    callbackPort,
    bootstrap: (name) => bootstrap(sessionManager, name),
  }));

  // Internal PTY exit route at /internal/pty/exit (where Electron callback server sends exit reports)
  app.post('/internal/pty/exit', async (req, res) => {
    const { agentName, terminalId, exitCode } = req.body || {};
    if (!agentName || exitCode === undefined) {
      return res.status(400).json(error('INVALID_REQUEST', 'agentName and exitCode required', 'pty_exit', req.requestId));
    }
    healthMonitor.handlePtyExit(agentName, terminalId || '', exitCode);
    // Fire lifecycle hooks (party signal removal, standup, SSE) — async, non-blocking
    app._lifecycleHooks?.onAgentExited(agentName, exitCode).catch(() => {});
    res.json(success({
      agent_name: agentName,
      exit_code: exitCode,
      new_status: backoffManager.get(agentName)?.status || 'unknown',
    }, 'pty_exit', req.requestId));
  });

  app.use('/v1/agents', bootstrapRoutes(sessionManager));
  app.use('/v1/agents', modifyRoutes(sessionManager));
  app.use('/v1/agents', execRoutes(sessionManager));
  app.use('/v1/sessions', sessionRoutes(sessionManager));

  const partyEngine = new PartyEngine(storage, appConfig);
  app.use('/v1/party', partyRoutes(storage, partyEngine));
  // /v1/messages — chat + clusters RETIRED in Phase 5 (replaced by /v1/chat/*)
  app.use('/v1/messages', messagingRoutes(storage));
  app.use('/v1/kanban', kanbanRoutes(storage, localEventBus));
  app.use('/v1/chat', chatRoutes(appConfig, localEventBus, storage));
  app.use('/v1/contractors', contractorRoutes(contractorService, appConfig, contractorSessionManager));
  app.use('/v1/contracts', contractRoutes(contractorService, contractorSessionManager));
  app.use('/v1/projects', projectRoutes(storage, localEventBus));
  app.use('/v1/documents', documentRoutes(storage));
  app.use('/v1/agents', agentRoutes(storage));

  // Autonomy supervisor — single instance shared with routes and lifecycle hooks
  const supervisor = new Supervisor(storage, appConfig);
  supervisor.link({ partyEngine, eventBus: localEventBus });
  app.use('/v1/autonomy', autonomyRoutes(supervisor));
  app.use('/v1/agents', registryRoutes(storage));
  app.use('/v1/notifications', notificationRoutes(storage));

  // Lifecycle hooks — wire party engine, standup, and SSE events
  const lifecycleHooks = new LifecycleHooks({
    eventBus: localEventBus,
    storage,
    supervisor,
  });

  // Wire mail-sent callback now that hooks exist
  mailSentCallback = (from, subject, to) => {
    lifecycleHooks.onMailSent(from, subject, to).catch(() => {});
  };

  app.use((req, res) => {
    res.status(404).json(error('NOT_FOUND', `Route not found: ${req.method} ${req.path}`, 'unknown', req.requestId));
  });

  app.use(errorHandler);

  app._sessionManager = sessionManager;
  app._partyEngine = partyEngine;
  app._upstreamSse = upstreamSse;
  app._backoffManager = backoffManager;
  app._healthMonitor = healthMonitor;
  app._lifecycleHooks = lifecycleHooks;
  app._localEventBus = localEventBus;
  return app;
}

if (process.argv[1]?.endsWith('server.js')) {
  // Config validation before creating app
  const { ok, warnings } = await validateConfig(config);
  if (!ok) {
    logger.error('server', 'Config validation failed — exiting');
    process.exit(1);
  }

  const app = await createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info('server', `Server running on ${config.host}:${config.port}`, { storage: 'vibesql' });
    if (config.acpLocalSecret) {
      logger.info('server', 'Local auth enabled');
    }

    // Start upstream SSE connections
    const agents = config.acpAgents;
    app._upstreamSse.start(agents);
    console.log(`[ACP] SSE upstream started for ${agents.length} agents`);

    // Start health monitor for Electron callback server
    app._healthMonitor.start();

    // Auto-spawn agents via Electron callback (if enabled and callback port configured)
    if (config.acpAutoSpawn && config.acpCallbackPort) {
      console.log(`[ACP] Auto-spawning ${agents.length} agents via callback port ${config.acpCallbackPort}`);
      for (const agentName of agents) {
        const state = app._backoffManager.getOrCreate(agentName);
        state.status = 'spawning';
        fetch(`http://127.0.0.1:${config.acpCallbackPort}/internal/pty/spawn`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.acpLocalSecret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agentName, autoReport: true }),
        }).then(async (res) => {
          if (res.ok) {
            const data = await res.json();
            const terminalId = data?.terminalId || data?.data?.terminalId || '';
            app._backoffManager.markSpawned(agentName, terminalId, '');
            console.log(`[ACP] Auto-spawned ${agentName}`);
          } else {
            state.status = 'error';
            console.warn(`[ACP] Auto-spawn failed for ${agentName}: HTTP ${res.status}`);
          }
        }).catch((err) => {
          state.status = 'error';
          console.warn(`[ACP] Auto-spawn failed for ${agentName}: ${err.message}`);
        });
      }
    }

    // Register graceful shutdown handlers
    registerShutdownHandlers({
      cfg: config,
      partyEngine: app._partyEngine,
      upstreamSse: app._upstreamSse,
      healthMonitor: app._healthMonitor,
      backoffManager: app._backoffManager,
      server,
      callbackPort: config.acpCallbackPort,
    });
    logger.info('server', 'Shutdown handlers registered');
  });
}
