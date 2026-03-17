import { createStorageAdapter } from '../storage/adapter.js';
import { config as defaultConfig } from '../config.js';

export class SessionManager {
  constructor(cfg) {
    this._config = cfg || defaultConfig;
    this._storage = createStorageAdapter(this._config);
  }

  async init() {
    await this._storage.init();
    // No fallback — if VibeSQL is unreachable, fail fast
  }

  async load(agentName) {
    const session = await this._storage.getSession(agentName);
    if (session) return { session, source: 'vibesql' };
    return null;
  }

  async save(session) {
    await this._storage.saveSession(session);
    return { savedTo: ['vibesql'] };
  }

  async delete(agentName) {
    await this._storage.deleteSession(agentName);
  }

  async list() {
    return await this._storage.listSessions();
  }

  get storage() {
    return this._storage;
  }
}
