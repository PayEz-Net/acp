import { createStorageAdapter } from '../storage/adapter.js';
import { config as defaultConfig } from '../config.js';
import * as fileBackup from '../storage/file_backup.js';

export class SessionManager {
  constructor(cfg) {
    this._config = cfg || defaultConfig;
    fileBackup.setConfig(this._config);
    this._storage = createStorageAdapter(this._config);
  }

  async init() {
    try {
      await this._storage.init();
    } catch (err) {
      console.warn('[SessionManager] Primary storage init failed, using file fallback:', err.message);
    }
  }

  async load(agentName) {
    try {
      const session = await this._storage.getSession(agentName);
      if (session) return { session, source: this._config.storageMode === 'virtual' ? 'vibe_api' : 'vibesql' };
    } catch (err) {
      console.warn(`[SessionManager] Primary storage load failed for ${agentName}:`, err.message);
    }

    const fileSession = await fileBackup.readSession(agentName);
    if (fileSession) return { session: fileSession, source: 'file' };

    return null;
  }

  async save(session) {
    const savedTo = [];
    try {
      await this._storage.saveSession(session);
      savedTo.push(this._config.storageMode === 'virtual' ? 'vibe_api' : 'vibesql');
    } catch (err) {
      console.warn(`[SessionManager] Primary storage save failed for ${session.agentName}:`, err.message);
    }

    await fileBackup.writeSession(session);
    savedTo.push('file');
    return { savedTo };
  }

  async delete(agentName) {
    try {
      await this._storage.deleteSession(agentName);
    } catch (err) {
      console.warn(`[SessionManager] Primary storage delete failed for ${agentName}:`, err.message);
    }

    await fileBackup.deleteSession(agentName);
  }

  async list() {
    try {
      const sessions = await this._storage.listSessions();
      if (sessions && sessions.length > 0) return sessions;
    } catch (err) {
      console.warn('[SessionManager] Primary storage list failed:', err.message);
    }

    return fileBackup.listSessions();
  }

  get storage() {
    return this._storage;
  }
}
