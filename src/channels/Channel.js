/**
 * Base Channel class — all channels implement this interface.
 * @abstract
 */
export class Channel {
  /**
   * @param {string} id — unique channel ID
   * @param {string} type — channel type (mission-control, telegram, whatsapp, discord, etc.)
   * @param {Object} config — channel-specific config
   */
  constructor(id, type, config = {}) {
    this.id = id;
    this.type = type;
    this.config = config;
    /** @type {'disconnected'|'connecting'|'connected'|'reconnecting'|'error'} */
    this.status = 'disconnected';
    /** @type {Function[]} */
    this._messageHandlers = [];
  }

  /** Connect to the channel */
  async connect() { throw new Error('Not implemented: connect()'); }

  /** Disconnect from the channel */
  async disconnect() { throw new Error('Not implemented: disconnect()'); }

  /**
   * Register inbound message handler
   * @param {(msg: import('../core/types.js').InboundMessage) => void} handler
   */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /**
   * Dispatch message to all handlers
   * @param {import('../core/types.js').InboundMessage} msg
   */
  _dispatch(msg) {
    for (const handler of this._messageHandlers) {
      try { handler(msg); } catch (e) {
        console.error(`[Channel:${this.id}] Handler error:`, e.message);
      }
    }
  }

  /**
   * Send text message
   * @param {string} chatId
   * @param {string} text
   * @param {import('../core/types.js').SendOptions} [opts]
   */
  async sendText(chatId, text, opts) { throw new Error('Not implemented: sendText()'); }

  /**
   * Send media
   * @param {string} chatId
   * @param {import('../core/types.js').MediaPayload} media
   * @param {import('../core/types.js').SendOptions} [opts]
   */
  async sendMedia(chatId, media, opts) { throw new Error('Not implemented: sendMedia()'); }

  /**
   * Send reaction
   * @param {string} chatId
   * @param {string} messageId
   * @param {string} emoji
   */
  async sendReaction(chatId, messageId, emoji) { /* optional, no-op by default */ }

  /**
   * Get channel capabilities
   * @returns {import('../core/types.js').ChannelCapabilities}
   */
  capabilities() {
    return {
      reactions: false,
      inlineButtons: false,
      voice: false,
      media: [],
      maxMessageLength: 4096,
      markdown: false,
      threads: false,
      edit: false,
      delete: false,
    };
  }

  /**
   * Health check
   * @returns {Promise<import('../core/types.js').HealthStatus>}
   */
  async healthCheck() {
    return {
      status: this.status === 'connected' ? 'healthy' : 'unhealthy',
      timestamp: Date.now(),
    };
  }
}
