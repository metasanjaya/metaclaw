/**
 * Self-heal playbook executor with state tracking.
 */
export class Recovery {
  constructor({ eventBus, channelManager, instanceManager, config = {} }) {
    this.eventBus = eventBus;
    this.channelManager = channelManager;
    this.instanceManager = instanceManager;
    this.config = config;
    /** @type {Map<string, {count: number, lastAttempt: number, lastResult: string}>} */
    this._retryState = new Map();
    this.maxRetries = config.maxRetries || 10;
    /** @type {Array<{ts: number, key: string, action: string, success: boolean, error?: string}>} */
    this.actions = [];
    this._maxActions = 200;
  }

  async handle(incident) {
    const handler = this._handlers[incident.type];
    if (!handler) return;

    const key = `${incident.type}:${incident.module}`;
    const state = this._retryState.get(key) || { count: 0, lastAttempt: 0, lastResult: 'none' };

    if (state.count >= this.maxRetries) {
      state.lastResult = 'exhausted';
      this._retryState.set(key, state);
      this.eventBus.emit('health.incident', {
        ...incident,
        type: 'recovery_exhausted',
        description: `Max retries (${this.maxRetries}) for ${key}`,
        actionTaken: 'notify_owner',
      });
      return;
    }

    const backoffMs = Math.min(1000 * Math.pow(2, state.count), 60000);
    const elapsed = Date.now() - state.lastAttempt;
    if (elapsed < backoffMs) return;

    state.count++;
    state.lastAttempt = Date.now();

    try {
      await handler.call(this, incident);
      state.count = 0;
      state.lastResult = 'resolved';
      this._logAction(key, handler.name || incident.type, true);
      console.log(`[Recovery] ✅ Resolved: ${key}`);
    } catch (e) {
      state.lastResult = `failed: ${e.message}`;
      this._logAction(key, handler.name || incident.type, false, e.message);
      console.error(`[Recovery] ❌ ${key} (attempt ${state.count}):`, e.message);
    }
    this._retryState.set(key, state);
  }

  _logAction(key, action, success, error) {
    this.actions.push({ ts: Date.now(), key, action, success, error });
    if (this.actions.length > this._maxActions) {
      this.actions = this.actions.slice(-this._maxActions);
    }
  }

  getState() {
    const entries = {};
    for (const [key, state] of this._retryState) {
      entries[key] = { ...state };
    }
    return {
      retryStates: entries,
      recentActions: this.actions.slice(-20),
      maxRetries: this.maxRetries,
    };
  }

  _handlers = {
    async channel_disconnect(incident) {
      const channelId = incident.module.replace('channel:', '');
      const channel = this.channelManager.get(channelId);
      if (!channel) return;
      console.log(`[Recovery] Reconnecting channel: ${channelId}`);
      await channel.connect();
    },

    async instance_stuck(incident) {
      const instanceId = incident.module.replace('instance:', '');
      console.log(`[Recovery] Restarting instance: ${instanceId}`);
      await this.instanceManager.stop(instanceId);
      await this.instanceManager.start(instanceId);
    },
  };
}
