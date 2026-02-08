import express from 'express';
import { config } from '../config.js';
import { SessionManager } from '../agents/session_manager.js';
import { cors, requestId, timing, errorHandler } from './middleware.js';
import { success, error } from './response.js';
import bootstrapRoutes from './routes/bootstrap.js';
import modifyRoutes from './routes/modify.js';
import execRoutes from './routes/exec.js';
import sessionRoutes from './routes/sessions.js';
import partyRoutes from './routes/party.js';
import messagingRoutes from './routes/messaging.js';
import kanbanRoutes from './routes/kanban.js';
import autonomyRoutes from './routes/autonomy.js';
import { PartyEngine } from '../collaboration/party_engine.js';

export async function createApp(cfg) {
  const appConfig = cfg || config;
  const app = express();

  app.use(express.json());
  app.use(cors(appConfig.corsOrigins));
  app.use(requestId);
  app.use(timing);

  const sessionManager = new SessionManager(appConfig);
  await sessionManager.init();
  const storage = sessionManager.storage;

  app.get('/health', async (req, res) => {
    const checks = { storage: 'unknown', filesystem: 'ok' };
    try {
      await storage.init();
      checks.storage = 'ok';
    } catch {
      checks.storage = 'degraded';
    }
    res.json(success(checks, 'health', req.requestId));
  });

  app.use('/v1/agents', bootstrapRoutes(sessionManager));
  app.use('/v1/agents', modifyRoutes(sessionManager));
  app.use('/v1/agents', execRoutes(sessionManager));
  app.use('/v1/sessions', sessionRoutes(sessionManager));

  const partyEngine = new PartyEngine(storage, appConfig);
  app.use('/v1/party', partyRoutes(storage, partyEngine));
  app.use('/v1/messages', messagingRoutes(storage));
  app.use('/v1/kanban', kanbanRoutes(storage));
  app.use('/v1/autonomy', autonomyRoutes(storage, appConfig));

  app.use((req, res) => {
    res.status(404).json(error('NOT_FOUND', `Route not found: ${req.method} ${req.path}`, 'unknown', req.requestId));
  });

  app.use(errorHandler);

  app._sessionManager = sessionManager;
  app._partyEngine = partyEngine;
  return app;
}

if (process.argv[1]?.endsWith('server.js')) {
  const app = await createApp();
  app.listen(config.port, () => {
    console.log(`[ACP] Server running on port ${config.port} (storage: ${config.storageMode})`);
  });
}
