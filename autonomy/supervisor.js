export class Supervisor {
  constructor(storage, cfg = {}) {
    this._storage = storage;
    this._maxRuntimeHours = cfg.autonomyMaxRuntimeHours || 4;
    this._notifyWebhook = cfg.notifyWebhook || null;
    this._partyEngine = null;
    this._eventBus = null;
    this.unattendedMode = false;
  }

  /** Inject party engine and event bus for unattended mode wiring. */
  link({ partyEngine, eventBus }) {
    this._partyEngine = partyEngine;
    this._eventBus = eventBus;
  }

  /**
   * Dead man's switch: if 0 SSE clients for deadManTimeoutMs (default 5 min)
   * while unattended mode is ON, auto-pause.
   * Called on party engine tick or its own interval.
   */
  _deadManZeroSince = null;
  _deadManTimeoutMs = 5 * 60 * 1000;
  _deadManTimer = null;

  startDeadManSwitch() {
    if (this._deadManTimer) return;
    this._deadManTimer = setInterval(() => this._checkDeadMan(), 10_000); // check every 10s
  }

  stopDeadManSwitch() {
    if (this._deadManTimer) {
      clearInterval(this._deadManTimer);
      this._deadManTimer = null;
    }
    this._deadManZeroSince = null;
  }

  async _checkDeadMan() {
    if (!this.unattendedMode || !this._eventBus) return;

    const clientCount = this._eventBus.sseClientCount;
    if (clientCount > 0) {
      // Clients connected — reset timer
      this._deadManZeroSince = null;
      return;
    }

    // No clients
    if (!this._deadManZeroSince) {
      this._deadManZeroSince = Date.now();
      return;
    }

    const elapsed = Date.now() - this._deadManZeroSince;
    if (elapsed >= this._deadManTimeoutMs) {
      console.warn('[Supervisor] Dead mans switch triggered — no SSE clients for 5 minutes');
      this._deadManZeroSince = null;
      await this.stopUnattended('dead_mans_switch');
    }
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

  /**
   * Start unattended mode: supervisor + party engine linked.
   * Agents work autonomously until a stop condition is met.
   */
  async startUnattended(config = {}) {
    if (this.unattendedMode) {
      const err = new Error('Unattended mode is already active');
      err.code = 'INVALID_REQUEST';
      throw err;
    }

    // Start supervisor with config
    await this.start({
      stopCondition: config.stopCondition || 'milestone',
      maxRuntimeHours: config.maxRuntimeHours || this._maxRuntimeHours,
      milestone: config.milestone || null,
      notifyWebhook: config.notifyWebhook || this._notifyWebhook,
    });

    this.unattendedMode = true;

    // Persist unattended fields
    await this._storage.updateAutonomyState({
      unattendedMode: true,
      escalationLevel: config.escalationLevel ?? 2,
    });

    // Start party engine
    if (this._partyEngine) {
      this._partyEngine.start();
    }

    // Start dead man's switch
    this.startDeadManSwitch();

    // Emit SSE event
    if (this._eventBus) {
      this._eventBus.emit({
        event: 'unattended-started',
        data: {
          mode: 'unattended',
          stop_condition: config.stopCondition || 'milestone',
          max_runtime_hours: config.maxRuntimeHours || this._maxRuntimeHours,
          escalation_level: config.escalationLevel ?? 2,
        },
      });
    }

    return this.getState();
  }

  /**
   * Stop unattended mode: party engine stops, supervisor stops, human notified.
   */
  async stopUnattended(reason = 'manual') {
    const wasUnattended = this.unattendedMode;
    this.unattendedMode = false;

    // Stop party engine
    if (this._partyEngine) {
      this._partyEngine.stop();
    }

    // Stop dead man's switch
    this.stopDeadManSwitch();

    // Persist unattended off
    await this._storage.updateAutonomyState({
      unattendedMode: false,
    });

    // Stop supervisor (handles webhook notify)
    let state;
    try {
      state = await this.stop(reason);
    } catch {
      // Supervisor may not be running if stop conditions already triggered
      state = await this.getState();
    }

    // Emit SSE event
    if (this._eventBus) {
      this._eventBus.emit({
        event: 'unattended-paused',
        data: {
          reason,
          was_unattended: wasUnattended,
          runtime_minutes: state?.startedAt
            ? Math.round((Date.now() - new Date(state.startedAt).getTime()) / 60000)
            : 0,
        },
      });
    }

    return state;
  }

  async getState() {
    const state = await this._storage.getAutonomyState();
    if (state) {
      state.unattendedMode = this.unattendedMode;
      state.partyEngineActive = this._partyEngine?.running ?? false;
    }
    return state;
  }

  /**
   * Emergency hard stop — immediate kill, no graceful shutdown.
   * Stops party engine, stops supervisor, returns kill list for caller to terminate PTYs.
   */
  async emergencyStop() {
    if (!this.unattendedMode) return { stopped: false, reason: 'not_running' };
    this.unattendedMode = false;
    this.stopDeadManSwitch();

    if (this._partyEngine) {
      this._partyEngine.stop();
    }

    await this._storage.updateAutonomyState({
      enabled: false,
      unattendedMode: false,
      stoppedAt: new Date().toISOString(),
      stopReason: 'emergency',
    });

    if (this._eventBus) {
      this._eventBus.emit({
        event: 'unattended-paused',
        data: { reason: 'emergency', was_unattended: true, hard_stop: true },
      });
    }

    return { stopped: true, reason: 'emergency' };
  }

  /**
   * Check process memory usage. Returns 'memory' stop reason if RSS exceeds threshold.
   * @param maxRssMb - RSS threshold in MB (default 2048 = 2GB)
   */
  checkMemory(maxRssMb = 2048) {
    const usage = process.memoryUsage();
    const rssMb = Math.round(usage.rss / 1024 / 1024);
    if (rssMb > maxRssMb) {
      return { exceeded: true, rssMb, maxRssMb };
    }
    return { exceeded: false, rssMb, maxRssMb };
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

    // F-2: Memory guardrail
    const mem = this.checkMemory();
    if (mem.exceeded) return 'memory';

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
