/**
 * Self-heal playbook executor.
 */
export class Recovery {
  constructor({ eventBus, channelManager, instanceManager, config = {} }) {
    this.eventBus = eventBus;
    this.channelManager = channelManager;
    this.instanceManager = instanceManager;
    this.config = config;
    /** @type {Map<string, {count: number, lastAttempt: number}>} */
    this._retryState = new Map();
    this.maxRetries = config.maxRetries || 10;
  }

  /**
   * Handle an incident with the appropriate recovery action
   * @param {import('../core/types.js').Incident} incident
   */
  async handle(incident) {
    const handler = this._handlers[incident.type];
    if (!handler) {
      console.warn(`[Recovery] No handler for incident type: ${incident.type}`);
      return;
    }

    const key = `${incident.type}:${incident.module}`;
    const state = this._retryState.get(key) || { count: 0, lastAttempt: 0 };

    if (state.count >= this.maxRetries) {
      console.error(`[Recovery] Max retries reached for ${key}. Manual intervention needed.`);
      this.eventBus.emit('health.incident', {
        ...incident,
        type: 'recovery_exhausted',
        description: `Max retries (${this.maxRetries}) reached for ${key}`,
        actionTaken: 'notify_owner',
      });
      return;
    }

    // Exponential backoff
    const backoffMs = Math.min(1000 * Math.pow(2, state.count), 60000);
    const elapsed = Date.now() - state.lastAttempt;
    if (elapsed < backoffMs) return;

    state.count++;
    state.lastAttempt = Date.now();
    this._retryState.set(key, state);

    try {
      await handler.call(this, incident);
      state.count = 0; // Reset on success
      console.log(`[Recovery] Resolved: ${key}`);
    } catch (e) {
      console.error(`[Recovery] Failed to handle ${key} (attempt ${state.count}):`, e.message);
    }
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
