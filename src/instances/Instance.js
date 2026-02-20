/**
 * Represents a single MetaClaw instance (independent agent).
 */
export class Instance {
  /**
   * @param {Object} opts
   * @param {string} opts.id
   * @param {Object} opts.config — resolved config (from ConfigManager)
   * @param {import('../core/EventBus.js').EventBus} opts.eventBus
   */
  constructor({ id, config, eventBus }) {
    this.id = id;
    this.config = config;
    this.eventBus = eventBus;
    this.identity = config._identity || {};
    this.dataDir = config._dir;

    /** @type {'stopped'|'initializing'|'ready'|'running'|'stopping'|'crashed'} */
    this.status = 'stopped';

    /** @type {string[]} — assigned channel IDs */
    this.channelIds = config.channels || [];

    /** @type {string[]} — enabled skill IDs */
    this.skillIds = config.skills || [];
  }

  get name() { return this.identity.name || this.id; }
  get personality() { return this.identity.personality || ''; }
  get emoji() { return this.identity.emoji || '🤖'; }
  get model() { return this.config.model?.primary || 'anthropic/claude-sonnet-4-6'; }

  /**
   * Start the instance
   */
  async start() {
    this.status = 'initializing';
    this.eventBus.emit('instance.spawn', { id: this.id, name: this.name });
    // TODO: init memory, load skills, connect to assigned channels
    this.status = 'running';
    console.log(`[Instance:${this.id}] ${this.emoji} ${this.name} is running (model: ${this.model})`);
  }

  /**
   * Stop the instance
   */
  async stop() {
    this.status = 'stopping';
    this.eventBus.emit('instance.stop', { id: this.id });
    // TODO: cleanup
    this.status = 'stopped';
    console.log(`[Instance:${this.id}] Stopped`);
  }

  /**
   * Handle inbound message (from assigned channel)
   * @param {import('../core/types.js').InboundMessage} msg
   */
  async handleMessage(msg) {
    if (this.status !== 'running') {
      console.warn(`[Instance:${this.id}] Received message but not running`);
      return;
    }
    // TODO: route to AI, execute skills, respond
    this.eventBus.emit('instance.message', { instanceId: this.id, message: msg });
  }

  /**
   * Health check
   * @returns {import('../core/types.js').HealthStatus}
   */
  healthCheck() {
    return {
      status: this.status === 'running' ? 'healthy' : 'unhealthy',
      message: `${this.name}: ${this.status}`,
      timestamp: Date.now(),
    };
  }
}
