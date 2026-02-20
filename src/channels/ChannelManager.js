import { Channel } from './Channel.js';

/**
 * Channel registry + lifecycle management.
 * Routes inbound messages to the correct instance.
 */
export class ChannelManager {
  /**
   * @param {import('../core/EventBus.js').EventBus} eventBus
   */
  constructor(eventBus) {
    this.eventBus = eventBus;
    /** @type {Map<string, Channel>} */
    this.channels = new Map();
  }

  /**
   * Register a channel
   * @param {Channel} channel
   */
  register(channel) {
    if (this.channels.has(channel.id)) {
      throw new Error(`Channel "${channel.id}" already registered`);
    }
    channel.onMessage((msg) => {
      this.eventBus.emit('message.in', msg);
    });
    this.channels.set(channel.id, channel);
    console.log(`[ChannelManager] Registered: ${channel.id} (${channel.type})`);
  }

  /**
   * Get channel by ID
   * @param {string} id
   * @returns {Channel|undefined}
   */
  get(id) {
    return this.channels.get(id);
  }

  /**
   * Connect all registered channels
   */
  async connectAll() {
    const results = [];
    for (const [id, channel] of this.channels) {
      try {
        await channel.connect();
        this.eventBus.emit('channel.connect', { channelId: id, type: channel.type });
        results.push({ id, status: 'connected' });
      } catch (e) {
        console.error(`[ChannelManager] Failed to connect ${id}:`, e.message);
        this.eventBus.emit('channel.error', { channelId: id, error: e.message });
        results.push({ id, status: 'error', error: e.message });
      }
    }
    return results;
  }

  /**
   * Disconnect all channels
   */
  async disconnectAll() {
    for (const [id, channel] of this.channels) {
      try {
        await channel.disconnect();
        this.eventBus.emit('channel.disconnect', { channelId: id });
      } catch (e) {
        console.error(`[ChannelManager] Error disconnecting ${id}:`, e.message);
      }
    }
  }

  /**
   * Health check all channels
   * @returns {Promise<Record<string, import('../core/types.js').HealthStatus>>}
   */
  async healthCheckAll() {
    const results = {};
    for (const [id, channel] of this.channels) {
      results[id] = await channel.healthCheck();
    }
    return results;
  }

  /**
   * Send text via specific channel
   * @param {string} channelId
   * @param {string} chatId
   * @param {string} text
   * @param {import('../core/types.js').SendOptions} [opts]
   */
  async sendText(channelId, chatId, text, opts) {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    await channel.sendText(chatId, text, opts);
    this.eventBus.emit('message.out', { channelId, chatId, text });
  }
}
