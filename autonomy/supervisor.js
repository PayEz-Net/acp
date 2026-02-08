export class Supervisor {
  constructor(storage, cfg = {}) {
    this._storage = storage;
    this._maxRuntimeHours = cfg.autonomyMaxRuntimeHours || 4;
    this._notifyWebhook = cfg.notifyWebhook || null;
  }

  async start(opts = {}) {
    const state = await this.getState();
    if (state?.enabled) {
      const err = new Error('Autonomy is already running');
      err.code = 'INVALID_REQUEST';
      throw err;
    }
    const now = new Date().toISOString();
    await this._storage.updateAutonomyState({
      enabled: true,
      startedAt: now,
      stopCondition: opts.stopCondition || 'milestone',
      currentMilestone: opts.milestone || null,
      maxRuntimeHours: opts.maxRuntimeHours || this._maxRuntimeHours,
      notifyWebhook: opts.notifyWebhook || this._notifyWebhook,
      stoppedAt: null,
      stopReason: null,
    });
    return this.getState();
  }

  async stop(reason = 'manual') {
    const state = await this.getState();
    if (!state?.enabled) {
      const err = new Error('Autonomy is not running');
      err.code = 'INVALID_REQUEST';
      throw err;
    }
    await this._storage.updateAutonomyState({
      enabled: false,
      stoppedAt: new Date().toISOString(),
      stopReason: reason,
    });
    await this._notify(reason);
    return this.getState();
  }

  async getState() {
    return this._storage.getAutonomyState();
  }

  async checkStopConditions(tasks = []) {
    const state = await this.getState();
    if (!state?.enabled) return null;

    const blockedCount = tasks.filter((t) => t.status === 'blocked').length;
    if (blockedCount >= 2) return 'blocker';

    const reviewCount = tasks.filter((t) => t.status === 'review').length;
    if (reviewCount >= 3) return 'review_queue';

    if (state.currentMilestone) {
      const milestoneTasks = tasks.filter((t) => t.milestone === state.currentMilestone);
      if (milestoneTasks.length > 0 && milestoneTasks.every((t) => t.status === 'done')) {
        return 'milestone';
      }
    }

    if (state.startedAt) {
      const elapsed = (Date.now() - new Date(state.startedAt).getTime()) / 3600000;
      if (elapsed >= (state.maxRuntimeHours || this._maxRuntimeHours)) {
        return 'max_runtime';
      }
    }

    return null;
  }

  async addStandupEntry(entry) {
    return this._storage.createStandupEntry({
      agentName: entry.agentName,
      entryType: entry.type || entry.entryType,
      summary: entry.summary,
      taskId: entry.taskId || null,
    });
  }

  async getStandup() {
    return this._storage.listStandupEntries();
  }

  async _notify(reason) {
    const state = await this.getState();
    const webhook = state?.notifyWebhook || this._notifyWebhook;
    if (!webhook) return;
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'autonomy_stopped', reason, timestamp: new Date().toISOString() }),
      });
    } catch {
      console.warn('[Supervisor] Webhook notification failed');
    }
  }
}
