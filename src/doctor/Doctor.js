import { Heartbeat } from './Heartbeat.js';
import { Recovery } from './Recovery.js';

/**
 * Health monitoring & self-healing coordinator.
 */
export class Doctor {
  /**
   * @param {Object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.eventBus
   * @param {import('../channels/ChannelManager.js').ChannelManager} opts.channelManager
   * @param {import('../instances/InstanceManager.js').InstanceManager} opts.instanceManager
   * @param {Object} [opts.config]
   */
  constructor({ eventBus, channelManager, instanceManager, config = {} }) {
    this.eventBus = eventBus;
    this.channelManager = channelManager;
    this.instanceManager = instanceManager;

    this.heartbeat = new Heartbeat({ eventBus, channelManager, instanceManager, config });
    this.recovery = new Recovery({ eventBus, channelManager, instanceManager, config });

    /** @type {import('../core/types.js').Incident[]} */
    this.incidents = [];
    this._maxIncidents = config.maxIncidents || 1000;
  }

  /**
   * Start monitoring
   */
  start() {
    this.heartbeat.start();

    this.eventBus.on('health.incident', (incident) => {
      this.incidents.push({ ...incident, id: crypto.randomUUID(), timestamp: Date.now() });
      if (this.incidents.length > this._maxIncidents) {
        this.incidents = this.incidents.slice(-this._maxIncidents);
      }
      this.recovery.handle(incident);
    });

    console.log('[Doctor] Monitoring started');
  }

  /**
   * Stop monitoring
   */
  stop() {
    this.heartbeat.stop();
    console.log('[Doctor] Monitoring stopped');
  }

  /**
   * Full health report
   */
  async report() {
    const channels = await this.channelManager.healthCheckAll();
    const instances = this.instanceManager.healthCheckAll();
    const recentIncidents = this.incidents.slice(-20);

    const overall = Object.values({ ...channels, ...instances })
      .every(h => h.status === 'healthy') ? 'healthy' : 'degraded';

    return { overall, channels, instances, recentIncidents, timestamp: Date.now() };
  }
}
