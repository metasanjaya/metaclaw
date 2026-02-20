/**
 * AI model router — wraps existing UnifiedAIClient with instance-aware routing.
 */
export class Router {
  /**
   * @param {Object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.eventBus
   * @param {Object} opts.globalConfig — global AI config
   */
  constructor({ eventBus, globalConfig = {} }) {
    this.eventBus = eventBus;
    this.globalConfig = globalConfig;
    /** @type {any} */
    this._client = null;
  }

  /**
   * Initialize the underlying AI client.
   * Lazy-loads UnifiedAIClient from existing v2 code.
   * @param {Object} aiConfig — config with provider API keys etc
   */
  async init(aiConfig) {
    try {
      const { UnifiedAIClient } = await import('../ai/UnifiedAIClient.js');
      this._client = new UnifiedAIClient(aiConfig);
      console.log('[Router] AI client initialized');
    } catch (e) {
      console.error('[Router] Failed to init AI client:', e.message);
    }
  }

  /**
   * Send a message to the AI model for a specific instance.
   * @param {Object} opts
   * @param {string} opts.instanceId
   * @param {string} opts.model — model name
   * @param {Array} opts.messages — conversation messages
   * @param {Object[]} [opts.tools] — function calling tools
   * @param {Object} [opts.options] — extra options (temperature, etc)
   * @returns {Promise<Object>} — AI response
   */
  async chat({ instanceId, model, messages, tools, options = {} }) {
    if (!this._client) throw new Error('Router not initialized');

    const start = Date.now();
    try {
      const response = await this._client.chat({
        model,
        messages,
        tools,
        ...options,
      });
      const latency = Date.now() - start;
      this.eventBus.emit('ai.response', { instanceId, model, latency, tokens: response.usage });
      return response;
    } catch (e) {
      this.eventBus.emit('ai.error', { instanceId, model, error: e.message });
      throw e;
    }
  }

  /**
   * Get available models/providers
   * @returns {string[]}
   */
  getProviders() {
    return this._client?.getProviders?.() || [];
  }
}
