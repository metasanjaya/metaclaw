/**
 * Represents a single MetaClaw instance (independent agent).
 */
export class Instance {
  /**
   * @param {Object} opts
   * @param {string} opts.id
   * @param {Object} opts.config — resolved config (from ConfigManager)
   * @param {import('../core/EventBus.js').EventBus} opts.eventBus
   * @param {import('../core/Router.js').Router} [opts.router]
   */
  constructor({ id, config, eventBus, router }) {
    this.id = id;
    this.config = config;
    this.eventBus = eventBus;
    this.router = router || null;
    this.identity = config._identity || {};
    this.dataDir = config._dir;

    /** @type {'stopped'|'initializing'|'ready'|'running'|'stopping'|'crashed'} */
    this.status = 'stopped';

    /** @type {string[]} — assigned channel IDs */
    this.channelIds = config.channels || [];

    /** @type {string[]} — enabled skill IDs */
    this.skillIds = config.skills || [];

    /** @type {Map<string, Array<{role:string, content:string}>>} chatId → messages */
    this.conversations = new Map();

    /** @type {{inputTokens:number, outputTokens:number, cost:number, requests:number}} */
    this.stats = { inputTokens: 0, outputTokens: 0, cost: 0, requests: 0 };
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
    this.status = 'running';
    console.log(`[Instance:${this.id}] ${this.emoji} ${this.name} is running (model: ${this.model})`);
  }

  /**
   * Stop the instance
   */
  async stop() {
    this.status = 'stopping';
    this.eventBus.emit('instance.stop', { id: this.id });
    this.status = 'stopped';
    console.log(`[Instance:${this.id}] Stopped`);
  }

  /**
   * Build system prompt from identity
   * @returns {string}
   */
  _buildSystemPrompt() {
    const parts = [`You are ${this.name}.`];
    if (this.personality) parts.push(this.personality);
    parts.push('Be helpful, concise, and friendly. Respond in the same language as the user.');
    return parts.join(' ');
  }

  /**
   * Get or create conversation history for a chat
   * @param {string} chatId
   * @returns {Array<{role:string, content:string}>}
   */
  _getConversation(chatId) {
    if (!this.conversations.has(chatId)) {
      this.conversations.set(chatId, []);
    }
    const conv = this.conversations.get(chatId);
    // Keep last 50 messages to avoid token overflow
    if (conv.length > 50) conv.splice(0, conv.length - 50);
    return conv;
  }

  /**
   * Handle inbound message (from assigned channel)
   * @param {import('../core/types.js').InboundMessage} msg
   * @returns {Promise<string|null>} response text
   */
  async handleMessage(msg) {
    if (this.status !== 'running') {
      console.warn(`[Instance:${this.id}] Received message but not running`);
      return null;
    }

    if (!this.router) {
      console.warn(`[Instance:${this.id}] No router available`);
      return null;
    }

    const chatId = msg.chatId;
    const conversation = this._getConversation(chatId);

    // Add user message
    conversation.push({ role: 'user', content: msg.text });

    try {
      // Build messages array with system prompt
      const messages = [
        { role: 'system', content: this._buildSystemPrompt() },
        ...conversation,
      ];

      console.log(`[Instance:${this.id}] Processing message from ${msg.senderId} (${conversation.length} msgs in context)`);

      const response = await this.router.chat({
        instanceId: this.id,
        model: this.model,
        messages,
        options: { maxTokens: 4096, temperature: 0.7 },
      });

      const text = response.text || response.content || '';

      // Track stats
      if (response.usage) {
        this.stats.inputTokens += response.usage.inputTokens || response.usage.prompt_tokens || 0;
        this.stats.outputTokens += response.usage.outputTokens || response.usage.completion_tokens || 0;
      }
      this.stats.requests++;

      // Add assistant response to conversation
      conversation.push({ role: 'assistant', content: text });

      // Emit for tracking
      this.eventBus.emit('instance.response', {
        instanceId: this.id,
        chatId,
        text,
        usage: response.usage,
        model: this.model,
      });

      return text;
    } catch (e) {
      console.error(`[Instance:${this.id}] AI error:`, e.message);
      this.eventBus.emit('instance.error', { instanceId: this.id, error: e.message });
      return `⚠️ Error: ${e.message}`;
    }
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

  /**
   * Get stats summary
   */
  getStats() {
    return { ...this.stats, id: this.id, name: this.name, model: this.model };
  }
}
