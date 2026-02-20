/**
 * Periodic health ping for channels and instances.
 */
export class Heartbeat {
  constructor({ eventBus, channelManager, instanceManager, config = {} }) {
    this.eventBus = eventBus;
    this.channelManager = channelManager;
    this.instanceManager = instanceManager;
    this.channelIntervalMs = config.channelHeartbeatMs || 30000;
    this.instanceIntervalMs = config.instanceHeartbeatMs || 15000;
    this._timers = [];
  }

  start() {
    this._timers.push(setInterval(() => this._checkChannels(), this.channelIntervalMs));
    this._timers.push(setInterval(() => this._checkInstances(), this.instanceIntervalMs));
    console.log('[Heartbeat] Started');
  }

  stop() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
  }

  async _checkChannels() {
    const results = await this.channelManager.healthCheckAll();
    for (const [id, health] of Object.entries(results)) {
      if (health.status !== 'healthy') {
        this.eventBus.emit('health.incident', {
          type: 'channel_disconnect',
          module: `channel:${id}`,
          description: `Channel ${id} is ${health.status}: ${health.message || 'no details'}`,
          actionTaken: 'none',
          resolved: false,
        });
      }
    }
    this.eventBus.emit('health.check', { scope: 'channels', results });
  }

  _checkInstances() {
    const results = this.instanceManager.healthCheckAll();
    for (const [id, health] of Object.entries(results)) {
      if (health.status !== 'healthy') {
        this.eventBus.emit('health.incident', {
          type: 'instance_stuck',
          module: `instance:${id}`,
          description: `Instance ${id} is ${health.status}: ${health.message || 'no details'}`,
          actionTaken: 'none',
          resolved: false,
        });
      }
    }
    this.eventBus.emit('health.check', { scope: 'instances', results });
  }
}
