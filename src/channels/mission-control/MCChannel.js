import { Channel } from '../Channel.js';
import { MCServer } from './server.js';

/**
 * Mission Control — default embedded web channel.
 * Provides dashboard + chat interface via WebSocket.
 */
export class MCChannel extends Channel {
  /**
   * @param {Object} opts
   * @param {string} [opts.id]
   * @param {Object} opts.config — { port, auth, ... }
   * @param {import('../../core/EventBus.js').EventBus} opts.eventBus
   * @param {import('../../instances/InstanceManager.js').InstanceManager} opts.instanceManager
   */
  constructor({ id, config, eventBus, instanceManager }) {
    super(id || 'mission-control', 'mission-control', config);
    this.eventBus = eventBus;
    this.instanceManager = instanceManager;
    this.server = new MCServer({
      port: config.port || 3100,
      auth: config.auth || {},
      eventBus,
      instanceManager,
      onMessage: (msg) => this._dispatch(msg),
    });
  }

  async connect() {
    this.status = 'connecting';
    await this.server.start();
    this.status = 'connected';
  }

  async disconnect() {
    this.status = 'disconnected';
    this.server.stop();
  }

  async sendText(chatId, text, opts) {
    this.server.sendToChat(chatId, { type: 'message', text, ...opts });
  }

  async sendMedia(chatId, media, opts) {
    this.server.sendToChat(chatId, { type: 'media', media, ...opts });
  }

  capabilities() {
    return {
      reactions: false,
      inlineButtons: true,
      voice: false,
      media: ['image', 'document'],
      maxMessageLength: 100000,
      markdown: true,
      threads: false,
      edit: true,
      delete: true,
    };
  }

  async healthCheck() {
    return {
      status: this.status === 'connected' ? 'healthy' : 'unhealthy',
      message: `MC on port ${this.config.port || 3100}`,
      latencyMs: 0,
      timestamp: Date.now(),
    };
  }
}
