import { Instance } from './Instance.js';

/**
 * Instance lifecycle management.
 */
export class InstanceManager {
  /**
   * @param {import('../core/ConfigManager.js').ConfigManager} configManager
   * @param {import('../core/EventBus.js').EventBus} eventBus
   * @param {import('../core/Router.js').Router} [router]
   */
  constructor(configManager, eventBus, router) {
    this.configManager = configManager;
    this.eventBus = eventBus;
    this.router = router || null;
    /** @type {Map<string, Instance>} */
    this.instances = new Map();
  }

  /**
   * Load all instances from config
   */
  loadAll() {
    for (const id of this.configManager.getInstanceIds()) {
      const config = this.configManager.getInstance(id);
      if (!config) continue;
      const instance = new Instance({ id, config, eventBus: this.eventBus, router: this.router });
      this.instances.set(id, instance);
    }
    console.log(`[InstanceManager] Loaded ${this.instances.size} instance(s)`);
  }

  /**
   * Start all instances
   */
  async startAll() {
    for (const [id, instance] of this.instances) {
      try {
        await instance.start();
      } catch (e) {
        console.error(`[InstanceManager] Failed to start ${id}:`, e.message);
        instance.status = 'crashed';
        this.eventBus.emit('instance.crash', { id, error: e.message });
      }
    }
  }

  /**
   * Start a specific instance
   * @param {string} id
   */
  async start(id) {
    const instance = this.instances.get(id);
    if (!instance) throw new Error(`Instance not found: ${id}`);
    await instance.start();
  }

  /**
   * Stop a specific instance
   * @param {string} id
   */
  async stop(id) {
    const instance = this.instances.get(id);
    if (!instance) throw new Error(`Instance not found: ${id}`);
    await instance.stop();
  }

  /**
   * Stop all instances
   */
  async stopAll() {
    for (const [, instance] of this.instances) {
      await instance.stop();
    }
  }

  /**
   * Get instance by ID
   * @param {string} id
   * @returns {Instance|undefined}
   */
  get(id) {
    return this.instances.get(id);
  }

  /**
   * List all instances with status
   * @returns {Array<{id: string, name: string, status: string, model: string}>}
   */
  list() {
    return [...this.instances.values()].map(i => ({
      id: i.id,
      name: i.name,
      emoji: i.emoji,
      status: i.status,
      model: i.model,
      channels: i.channelIds,
    }));
  }

  /**
   * Health check all instances
   */
  healthCheckAll() {
    const results = {};
    for (const [id, instance] of this.instances) {
      results[id] = instance.healthCheck();
    }
    return results;
  }
}
