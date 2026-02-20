import { ChatStore } from './ChatStore.js';
import { MemoryManager } from './MemoryManager.js';
import { KnowledgeManager } from './KnowledgeManager.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

    /** @type {ChatStore|null} */
    this.chatStore = null;

    /** @type {MemoryManager|null} */
    this.memory = null;
    /** @type {KnowledgeManager|null} */
    this.knowledge = null;

    /** @type {{inputTokens:number, outputTokens:number, cost:number, requests:number}} */
    this.stats = { inputTokens: 0, outputTokens: 0, cost: 0, requests: 0, totalMessages: 0 };
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
    // Init persistent chat store
    if (this.dataDir) {
      try {
        this.chatStore = new ChatStore(this.dataDir);
        console.log(`[Instance:${this.id}] Chat store initialized`);
      } catch (e) {
        console.error(`[Instance:${this.id}] Chat store error:`, e.message);
      }
    }
    // Init memory + knowledge managers
    if (this.dataDir) {
      try {
        this.memory = new MemoryManager(this.dataDir);
        this.memory.initialize();
        console.log(`[Instance:${this.id}] Memory initialized (${this.memory.dailyLogs.size} daily logs)`);
      } catch (e) {
        console.error(`[Instance:${this.id}] Memory error:`, e.message);
      }
      try {
        this.knowledge = new KnowledgeManager(this.dataDir);
        console.log(`[Instance:${this.id}] Knowledge initialized (${this.knowledge.count()} facts)`);
      } catch (e) {
        console.error(`[Instance:${this.id}] Knowledge error:`, e.message);
      }
    }
    // Load stats from DB
    if (this.chatStore) {
      try {
        const count = this.chatStore.db.prepare('SELECT COUNT(*) as c FROM messages WHERE role = ?').get('assistant');
        this.stats.requests = count?.c || 0;
        this.stats.totalMessages = this.chatStore.db.prepare('SELECT COUNT(*) as c FROM messages').get()?.c || 0;
      } catch {}
    }
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
  /**
   * Build system prompt with full personality stack:
   * 1. Identity (name, personality)
   * 2. SOUL.md (deep personality)
   * 3. WORKFLOW.md (system rules, read-only)
   * 4. MY_RULES.md (learned rules)
   * 5. Memory context (long-term + recent daily)
   * 6. Knowledge (relevant facts injected per query)
   */
  _buildSystemPrompt(userMessage = '') {
    const parts = [];
    const dir = this.config._dir;

    // 1. Identity
    parts.push(`You are ${this.name}.`);
    if (this.personality) parts.push(this.personality);

    // 2. SOUL.md
    if (dir) {
      try {
        const soulPath = join(dir, 'SOUL.md');
        if (existsSync(soulPath)) parts.push('\n' + readFileSync(soulPath, 'utf8').trim());
      } catch {}
    }

    // 3. WORKFLOW.md (shared/read-only system rules)
    if (dir) {
      try {
        const wfPath = join(dir, 'WORKFLOW.md');
        if (existsSync(wfPath)) parts.push('\n' + readFileSync(wfPath, 'utf8').trim());
      } catch {}
    }

    // 4. MY_RULES.md (learned rules)
    if (dir) {
      try {
        const rulesPath = join(dir, 'MY_RULES.md');
        if (existsSync(rulesPath)) {
          const rules = readFileSync(rulesPath, 'utf8').trim();
          if (rules) parts.push('\n## Learned Rules\n' + rules);
        }
      } catch {}
    }

    // 5. Memory context
    if (this.memory) {
      const memCtx = this.memory.getContextForPrompt(3000);
      if (memCtx) parts.push('\n' + memCtx);
    }

    // 6. Knowledge (query-relevant facts)
    if (this.knowledge && userMessage) {
      const kCtx = this.knowledge.getContextForQuery(userMessage, 6);
      if (kCtx) parts.push('\n' + kCtx);
    }

    // Fallback instruction
    parts.push('\nBe helpful, concise, and friendly. Respond in the same language as the user.');

    return parts.join('\n');
  }

  /**
   * Get conversation history from persistent store
   * @param {string} chatId
   * @returns {Array<{role:string, content:string}>}
   */
  _getConversation(chatId) {
    if (this.chatStore) {
      return this.chatStore.getConversation(chatId, 50);
    }
    return [];
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

    // Persist user message
    if (this.chatStore) {
      this.chatStore.save({ id: msg.id, chatId, role: 'user', text: msg.text, senderId: msg.senderId, timestamp: msg.timestamp });
    }

    // Load conversation from store
    const conversation = this._getConversation(chatId);

    try {
      // Build messages array with system prompt
      const messages = [
        { role: 'system', content: this._buildSystemPrompt(msg.text) },
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
      const inTok = response.inputTokens || response.usage?.inputTokens || response.usage?.prompt_tokens || 0;
      const outTok = response.outputTokens || response.usage?.outputTokens || response.usage?.completion_tokens || 0;
      this.stats.inputTokens += inTok;
      this.stats.outputTokens += outTok;
      this.stats.requests++;

      // Persist assistant response
      if (this.chatStore) {
        this.chatStore.save({ id: crypto.randomUUID(), chatId, role: 'assistant', text, timestamp: Date.now() });
      }

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
